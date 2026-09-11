import { randomBytes } from 'node:crypto';
import { decrypt, encrypt, storedSecretNames, type AppSpec } from '@tp/core';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type Database } from './client.js';
import { applicationSecrets } from './schema/secrets.js';

/**
 * Magasin des valeurs de secrets d'application.
 *
 * Règle absolue, calquée sur `targets.ts` : `encrypted_value` ne sort d'ici que
 * par `resolveApplicationSecrets()`, réservé au worker. Toutes les autres
 * lectures passent par `publicColumns`, où la colonne n'existe simplement pas —
 * la valeur ne peut donc pas fuir par oubli de filtrage dans un handler.
 *
 * Aucune fonction de ce module ne retourne une valeur en clair à un humain :
 * il n'existe pas de « lire un secret ». On en pose un, on le remplace, on le
 * régénère, on le supprime. C'est tout.
 */

const publicColumns = {
  id: applicationSecrets.id,
  applicationId: applicationSecrets.applicationId,
  name: applicationSecrets.name,
  origin: applicationSecrets.origin,
  createdAt: applicationSecrets.createdAt,
  updatedAt: applicationSecrets.updatedAt,
} as const;

export type SecretOrigin = 'generated' | 'provided';

/** Un secret tel que l'API a le droit de le décrire. Sans sa valeur. */
export type PublicApplicationSecret = {
  id: string;
  applicationId: string;
  name: string;
  origin: SecretOrigin;
  createdAt: Date;
  updatedAt: Date;
};

/** Même grammaire que `serviceSchema.secrets` dans l'AppSpec. */
export const secretNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Z_][A-Z0-9_]*$/, 'nom en MAJUSCULES_AVEC_UNDERSCORES');

/**
 * Valeur saisie par un opérateur.
 *
 * Le minimum est volontairement `0` : certaines images distinguent « variable
 * absente » de « variable vide », et c'est à l'opérateur de trancher. Le rendu
 * ne confond pas les deux non plus — il échoue sur un secret *absent* du
 * magasin, jamais sur un secret délibérément vide.
 */
export const secretValueSchema = z.string().max(8192);

/** Octets d'entropie d'une valeur générée. 24 → 32 caractères base64url. */
const GENERATED_SECRET_BYTES = 24;

/**
 * Valeur générée par le panel.
 *
 * base64url : l'alphabet (`A-Za-z0-9-_`) traverse sans échappement un `.env`,
 * une ligne de commande, un `stringData` de Secret Kubernetes et une URL de
 * connexion `postgres://`. Un mot de passe qui doit être cité quelque part
 * finit toujours par être mal cité à un endroit.
 */
export function generateSecretValue(): string {
  return randomBytes(GENERATED_SECRET_BYTES).toString('base64url');
}

export async function listApplicationSecrets(
  applicationId: string,
  db: Database = getDb(),
): Promise<PublicApplicationSecret[]> {
  return db
    .select(publicColumns)
    .from(applicationSecrets)
    .where(eq(applicationSecrets.applicationId, applicationId))
    .orderBy(asc(applicationSecrets.name));
}

/**
 * Crée les secrets déclarés qui n'existent pas encore, avec une valeur générée.
 *
 * ── Génération par défaut, saisie en surcharge ──────────────────────────────
 *
 * Le mot de passe que GLPI utilise pour joindre sa base n'a aucune raison
 * d'être choisi par un humain : personne ne le tape jamais, personne ne le lit
 * jamais, et un opérateur à qui l'on demande un mot de passe en écrit un
 * mauvais. Le panel le tire au sort, fort, et l'affaire est close. Un secret
 * *externe* — clé d'API d'un service tiers — ne peut pas être deviné : il est
 * alors saisi, et `setApplicationSecret()` le marque `provided`.
 *
 * Générer par défaut a une conséquence qu'on veut : **aucun déploiement ne peut
 * plus échouer faute d'avoir renseigné un secret**, ce qui était exactement la
 * panne d'origine. La saisie reste possible, elle n'est jamais obligatoire.
 *
 * Idempotente : appelée à la création de l'application, à chaque mise à jour de
 * son AppSpec, et une dernière fois par le worker avant le rendu — cette
 * troisième fois couvre les applications créées avant l'existence du magasin.
 * `onConflictDoNothing` fait de la contrainte unique l'arbitre, pas un `if`.
 *
 * Retourne les noms réellement créés, pour que l'appelant puisse les journaliser.
 */
export async function ensureApplicationSecrets(
  applicationId: string,
  names: readonly string[],
  db: Database = getDb(),
): Promise<string[]> {
  const wanted = [...new Set(names)];
  if (wanted.length === 0) return [];

  const created = await db
    .insert(applicationSecrets)
    .values(
      wanted.map((name) => ({
        applicationId,
        name,
        encryptedValue: encrypt(generateSecretValue()),
        origin: 'generated' as const,
      })),
    )
    .onConflictDoNothing({
      target: [applicationSecrets.applicationId, applicationSecrets.name],
    })
    .returning({ name: applicationSecrets.name });

  return created.map((row) => row.name);
}

/**
 * Noms de secrets d'une AppSpec qui ont besoin d'une **valeur** en magasin.
 *
 * Les racines uniquement. Un secret qui déclare `from` reprend la valeur d'un
 * autre : il n'a pas de ligne à lui. En créer une le ferait retomber sur la
 * panne d'origine — deux valeurs aléatoires indépendantes pour un seul mot de
 * passe — avec une étape de plus.
 */
export function declaredSecretsOf(spec: AppSpec): string[] {
  return storedSecretNames(spec);
}

/**
 * Aligne le magasin sur l'AppSpec courante.
 *
 * ── Ce qui se passe quand l'AppSpec évolue ─────────────────────────────────
 *
 * Un secret **ajouté** est créé à la volée, avec une valeur générée : rien à
 * faire pour l'opérateur, le prochain déploiement le trouvera.
 *
 * Un secret **retiré** n'est pas supprimé. Une valeur détruite ne revient pas,
 * et le volume de données qui s'en sert, lui, est toujours là : une AppSpec
 * éditée à la main puis corrigée aurait effacé le mot de passe d'une base
 * toujours en service. La ligne reste donc, marquée « plus déclarée » par
 * l'écran, et seule une suppression explicite la retire. Le seul effacement
 * automatique est celui de la cascade quand l'application elle-même disparaît.
 */
export async function syncApplicationSecrets(
  applicationId: string,
  spec: AppSpec,
  db: Database = getDb(),
): Promise<string[]> {
  return ensureApplicationSecrets(applicationId, declaredSecretsOf(spec), db);
}

/** Pose ou remplace la valeur d'un secret. Ne retourne jamais la valeur. */
export async function setApplicationSecret(
  applicationId: string,
  name: string,
  value: string,
  origin: SecretOrigin = 'provided',
  db: Database = getDb(),
): Promise<PublicApplicationSecret> {
  const [row] = await db
    .insert(applicationSecrets)
    .values({ applicationId, name, encryptedValue: encrypt(value), origin })
    .onConflictDoUpdate({
      target: [applicationSecrets.applicationId, applicationSecrets.name],
      set: { encryptedValue: encrypt(value), origin, updatedAt: new Date() },
    })
    .returning(publicColumns);

  if (!row) throw new Error("setApplicationSecret : l'écriture n'a retourné aucune ligne");
  return row;
}

/** Remplace la valeur par une nouvelle valeur tirée au sort. */
export async function rotateApplicationSecret(
  applicationId: string,
  name: string,
  db: Database = getDb(),
): Promise<PublicApplicationSecret> {
  return setApplicationSecret(applicationId, name, generateSecretValue(), 'generated', db);
}

export async function deleteApplicationSecret(
  applicationId: string,
  name: string,
  db: Database = getDb(),
): Promise<boolean> {
  const [row] = await db
    .delete(applicationSecrets)
    .where(
      and(
        eq(applicationSecrets.applicationId, applicationId),
        eq(applicationSecrets.name, name),
      ),
    )
    .returning({ id: applicationSecrets.id });
  return row !== undefined;
}

/**
 * Déchiffre les valeurs demandées. **Worker uniquement.**
 * Aucune route HTTP ne doit appeler cette fonction.
 *
 * Un nom absent du magasin est absent du résultat — il n'est pas remplacé par
 * une chaîne vide. C'est cette distinction que le rendu exploite pour échouer
 * en nommant le secret manquant plutôt que d'écrire un `.env` muet.
 */
export async function resolveApplicationSecrets(
  applicationId: string,
  names: readonly string[],
  db: Database = getDb(),
): Promise<Record<string, string>> {
  const wanted = [...new Set(names)];
  if (wanted.length === 0) return {};

  const rows = await db
    .select({ name: applicationSecrets.name, encryptedValue: applicationSecrets.encryptedValue })
    .from(applicationSecrets)
    .where(
      and(
        eq(applicationSecrets.applicationId, applicationId),
        inArray(applicationSecrets.name, wanted),
      ),
    );

  const values: Record<string, string> = {};
  for (const row of rows) values[row.name] = decrypt(row.encryptedValue);
  return values;
}
