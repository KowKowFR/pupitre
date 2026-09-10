import type { AppSettings, AppSettingsPatch, OnboardingState } from '@tp/core';
import {
  DEFAULT_APP_SETTINGS,
  appSettingsSchema,
  encrypt,
  decrypt,
  mergeAppSettings,
  parseAppSettings,
} from '@tp/core';
import { eq } from 'drizzle-orm';
import { getDb, type Database } from './client.js';
import { appSettings } from './schema/settings.js';

/**
 * Accès aux paramètres d'instance.
 *
 * Règle absolue, calquée sur `targets.ts` : `ai_api_key_encrypted` ne sort d'ici
 * que par `getAiApiKey()`. Toutes les autres lectures rendent un
 * `AppSettingsRecord`, où la clé n'existe simplement pas — seulement le fait
 * qu'elle soit posée et ses quatre derniers caractères. Le secret ne peut donc
 * pas fuir par oubli de filtrage dans un handler.
 */

/** Ligne unique. Le singleton est garanti par la base (`check (id = 1)`). */
const SINGLETON_ID = 1;

export type AppSettingsRecord = {
  settings: AppSettings;
  /** Une clé est-elle enregistrée ? Jamais la clé elle-même. */
  aiApiKeyConfigured: boolean;
  /** Quatre derniers caractères, pour reconnaître la clé sans la révéler. */
  aiApiKeyLast4: string | null;
  updatedAt: Date | null;
  updatedBy: string | null;
};

const EMPTY_RECORD: AppSettingsRecord = {
  settings: DEFAULT_APP_SETTINGS,
  aiApiKeyConfigured: false,
  aiApiKeyLast4: null,
  updatedAt: null,
  updatedBy: null,
};

/**
 * Cache mémoire très court.
 *
 * Chaque rendu de page lit les paramètres — le nom de l'instance en haut à
 * gauche, le fuseau de chaque date. Une requête SQL par rendu serait du
 * gâchis pour une ligne qui change trois fois par an. Cinq secondes suffisent
 * à absorber la rafale d'un chargement de page sans qu'un réglage mette
 * visiblement du temps à apparaître.
 *
 * Le cache est **par processus** : le panel et le worker ont chacun le leur.
 * Une écriture invalide celui du processus qui écrit ; l'autre rattrape au
 * plus tard au bout du TTL. C'est acceptable ici — aucun de ces réglages n'est
 * une décision de sécurité, et rien ne dépend d'une cohérence à la seconde.
 */
const CACHE_TTL_MS = 5_000;

type CacheEntry = { record: AppSettingsRecord; expiresAt: number };
let cache: CacheEntry | null = null;

/** Vide le cache. Appelée à chaque écriture, et par les tests. */
export function invalidateAppSettingsCache(): void {
  cache = null;
}

function last4(plaintext: string): string | null {
  return plaintext.length >= 4 ? plaintext.slice(-4) : null;
}

function toRecord(row: typeof appSettings.$inferSelect | undefined): AppSettingsRecord {
  if (!row) return EMPTY_RECORD;

  let aiApiKeyLast4: string | null = null;
  if (row.aiApiKeyEncrypted) {
    try {
      aiApiKeyLast4 = last4(decrypt(row.aiApiKeyEncrypted));
    } catch {
      // Clé illisible (MASTER_KEY changée) : elle reste « configurée » — la
      // colonne est pleine — mais on n'en montre rien. Le déchiffrement réel
      // échouera au moment de s'en servir, avec un message explicite.
      aiApiKeyLast4 = null;
    }
  }

  return {
    settings: parseAppSettings(row.value),
    aiApiKeyConfigured: row.aiApiKeyEncrypted !== null,
    aiApiKeyLast4,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}

/**
 * Lecture. Ne lève jamais parce que la ligne est absente ou incomplète : une
 * base vierge rend les défauts du schéma.
 */
export async function getAppSettings(db: Database = getDb()): Promise<AppSettingsRecord> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.record;

  const [row] = await db.select().from(appSettings).where(eq(appSettings.id, SINGLETON_ID));
  const record = toRecord(row);
  cache = { record, expiresAt: now + CACHE_TTL_MS };
  return record;
}

/** Raccourci : seulement les réglages, sans les métadonnées de la clé. */
export async function getAppSettingsValue(db: Database = getDb()): Promise<AppSettings> {
  return (await getAppSettings(db)).settings;
}

/**
 * Clé d'API en clair. **Seul** point de déchiffrement.
 * Réservé au code serveur qui va réellement appeler le fournisseur ; le
 * résultat ne doit ni être journalisé, ni traverser une réponse HTTP.
 */
export async function getAiApiKey(db: Database = getDb()): Promise<string | null> {
  const [row] = await db
    .select({ encrypted: appSettings.aiApiKeyEncrypted })
    .from(appSettings)
    .where(eq(appSettings.id, SINGLETON_ID));

  if (!row?.encrypted) return null;
  return decrypt(row.encrypted);
}

/**
 * Trois cas distincts pour la clé, et ils doivent le rester :
 *   champ absent  → inchangée
 *   `null`        → effacée
 *   chaîne        → remplacée
 * D'où le test d'existence de la propriété plutôt qu'une comparaison à
 * `undefined`, qui confondrait « absent » et « explicitement vide ».
 */
export type AppSettingsUpdate = AppSettingsPatch & { aiApiKey?: string | null };

/** Ce qu'une écriture a fait de la clé — de quoi rédiger l'entrée d'audit. */
export type AiApiKeyChange = 'unchanged' | 'set' | 'cleared';

export type AppSettingsUpdateResult = {
  before: AppSettingsRecord;
  after: AppSettingsRecord;
  keyChange: AiApiKeyChange;
};

/**
 * Fusion superficielle, validation Zod, upsert sur la ligne unique.
 * La validation a lieu *avant* l'écriture : un fuseau inventé n'atteint jamais
 * la base, et l'erreur Zod remonte telle quelle à l'appelant (422 côté API).
 */
export async function updateAppSettings(
  patch: AppSettingsUpdate,
  actorId: string | null,
  db: Database = getDb(),
): Promise<AppSettingsUpdateResult> {
  const { aiApiKey, ...settingsPatch } = patch;
  const keyProvided = Object.hasOwn(patch, 'aiApiKey');

  // Lecture directe, sans passer par le cache : une écriture doit partir de
  // l'état réellement en base, pas d'un instantané vieux de cinq secondes.
  const [currentRow] = await db.select().from(appSettings).where(eq(appSettings.id, SINGLETON_ID));
  const before = toRecord(currentRow);

  const value = mergeAppSettings(before.settings, settingsPatch);

  let encryptedKey: string | null = currentRow?.aiApiKeyEncrypted ?? null;
  let keyChange: AiApiKeyChange = 'unchanged';
  if (keyProvided) {
    if (aiApiKey === null || aiApiKey === undefined) {
      encryptedKey = null;
      keyChange = 'cleared';
    } else {
      encryptedKey = encrypt(aiApiKey);
      keyChange = 'set';
    }
  }

  const [row] = await db
    .insert(appSettings)
    .values({
      id: SINGLETON_ID,
      value,
      aiApiKeyEncrypted: encryptedKey,
      updatedAt: new Date(),
      updatedBy: actorId,
    })
    .onConflictDoUpdate({
      target: appSettings.id,
      set: {
        value,
        aiApiKeyEncrypted: encryptedKey,
        updatedAt: new Date(),
        updatedBy: actorId,
      },
    })
    .returning();

  invalidateAppSettingsCache();
  return { before, after: toRecord(row), keyChange };
}

/**
 * Écriture réservée à l'avancement de l'assistant de démarrage.
 *
 * Séparée de `updateAppSettings()` pour deux raisons. D'abord la surface :
 * `appSettingsPatchSchema` ne porte pas `onboarding`, précisément pour que
 * l'écran des paramètres ne puisse pas déclarer un parcours terminé au détour
 * d'un changement de fuseau. Ensuite la clé d'API : la lecture-modification se
 * fait ici sur le seul JSONB, la colonne chiffrée n'est pas touchée — pas même
 * réécrite à l'identique, ce qui la mettrait à la merci d'un `MASTER_KEY`
 * absent.
 *
 * La transformation est passée en fonction plutôt qu'en valeur : la transition
 * vit dans `@tp/core` (`applyOnboardingAction`), et l'appelant ne peut pas
 * écrire un état qu'il aurait fabriqué à côté des règles.
 */
export async function updateOnboardingState(
  apply: (current: OnboardingState) => OnboardingState,
  actorId: string | null,
  db: Database = getDb(),
): Promise<{ before: OnboardingState; after: OnboardingState }> {
  // Lecture directe : une écriture part de l'état réel, jamais du cache.
  const [currentRow] = await db.select().from(appSettings).where(eq(appSettings.id, SINGLETON_ID));
  const current = parseAppSettings(currentRow?.value);
  const after = apply(current.onboarding);

  const value = appSettingsSchema.parse({ ...current, onboarding: after });

  await db
    .insert(appSettings)
    .values({
      id: SINGLETON_ID,
      value,
      aiApiKeyEncrypted: currentRow?.aiApiKeyEncrypted ?? null,
      updatedAt: new Date(),
      updatedBy: actorId,
    })
    .onConflictDoUpdate({
      target: appSettings.id,
      // `aiApiKeyEncrypted` est absent du `set` : la clé enregistrée survit à
      // chaque pas de l'assistant sans jamais transiter par ce chemin.
      set: { value, updatedAt: new Date(), updatedBy: actorId },
    });

  invalidateAppSettingsCache();
  return { before: current.onboarding, after };
}
