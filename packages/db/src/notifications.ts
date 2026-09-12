import {
  channelConfigSchema,
  channelSecretFields,
  channelSecretsSchema,
  decrypt,
  encrypt,
  isNotificationEventKey,
  type ChannelConfig,
  type NotificationChannelKind,
  type NotificationEventKey,
  type ResolvedChannelConfig,
} from '@pupitre/core';
import { and, eq, sql } from 'drizzle-orm';
import { getDb, type Database } from './client.js';
import { users } from './schema/auth.js';
import { notificationChannels } from './schema/notifications.js';

/**
 * Accès aux canaux de notification.
 *
 * Règle absolue, calquée sur `targets.ts` et `settings.ts` :
 * `encrypted_secrets` ne sort d'ici que par `resolveNotificationChannel()`.
 * Toutes les autres lectures rendent un `NotificationChannelRecord`, où les
 * secrets n'existent simplement pas — seulement la **liste des champs
 * renseignés**. Un secret ne peut donc pas fuir par oubli de filtrage dans un
 * handler : il n'est pas là.
 */

export type NotificationChannelRow = typeof notificationChannels.$inferSelect;

/** Ce qui sort d'ici vers une route, un écran ou un journal. Jamais de secret. */
export type NotificationChannelRecord = {
  id: string;
  kind: NotificationChannelKind;
  name: string;
  enabled: boolean;
  config: ChannelConfig;
  events: NotificationEventKey[];
  /** Noms des champs secrets réellement renseignés. Jamais leur valeur. */
  configuredSecrets: string[];
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastError: string | null;
  consecutiveFailures: number;
  createdAt: Date;
  updatedAt: Date;
};

/** Nom déjà pris. La base le refuserait de toute façon ; on le dit mieux. */
export class NotificationChannelNameTakenError extends Error {
  readonly channelName: string;

  constructor(channelName: string) {
    super(`Un canal nommé « ${channelName} » existe déjà`);
    this.name = 'NotificationChannelNameTakenError';
    this.channelName = channelName;
  }
}

/** Code Postgres d'une violation de contrainte d'unicité. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

function decodeSecrets(encrypted: string | null): ChannelConfig {
  if (!encrypted) return {};
  try {
    const parsed: unknown = JSON.parse(decrypt(encrypted));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as ChannelConfig)
      : {};
  } catch {
    // `MASTER_KEY` changée, ou colonne abîmée. Le canal reste « configuré » —
    // la colonne est pleine — mais rien n'en est lisible. L'échec réel se
    // produira à l'envoi, avec un message explicite, plutôt qu'ici où il
    // ferait échouer un simple affichage de liste.
    return {};
  }
}

function configuredSecretsOf(row: NotificationChannelRow): string[] {
  if (!row.encryptedSecrets) return [];
  const decoded = decodeSecrets(row.encryptedSecrets);
  return channelSecretFields(row.kind).filter((field) => {
    const value = decoded[field];
    return typeof value === 'string' && value.length > 0;
  });
}

function toRecord(row: NotificationChannelRow): NotificationChannelRecord {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    enabled: row.enabled,
    config: row.config,
    events: row.events.filter(isNotificationEventKey),
    configuredSecrets: configuredSecretsOf(row),
    lastSuccessAt: row.lastSuccessAt,
    lastFailureAt: row.lastFailureAt,
    lastError: row.lastError,
    consecutiveFailures: row.consecutiveFailures,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ─── lecture ──────────────────────────────────────────────────────────────────

export async function listNotificationChannels(
  db: Database = getDb(),
): Promise<NotificationChannelRecord[]> {
  const rows = await db.select().from(notificationChannels).orderBy(notificationChannels.name);
  return rows.map(toRecord);
}

export async function getNotificationChannel(
  id: string,
  db: Database = getDb(),
): Promise<NotificationChannelRecord | null> {
  const [row] = await db.select().from(notificationChannels).where(eq(notificationChannels.id, id));
  return row ? toRecord(row) : null;
}

/**
 * Configuration complète, secrets déchiffrés. **Seul** point de déchiffrement.
 *
 * Réservé au code qui va réellement émettre — c'est-à-dire au worker. Le
 * résultat ne doit ni être journalisé, ni traverser une réponse HTTP, ni entrer
 * dans une entrée d'audit.
 */
export async function resolveNotificationChannel(
  id: string,
  db: Database = getDb(),
): Promise<{ row: NotificationChannelRow; resolved: ResolvedChannelConfig } | null> {
  const [row] = await db.select().from(notificationChannels).where(eq(notificationChannels.id, id));
  if (!row) return null;
  return { row, resolved: { config: row.config, secrets: decodeSecrets(row.encryptedSecrets) } };
}

/**
 * Canaux actifs abonnés à cet événement.
 *
 * Le filtre sur `events` est fait en SQL (`jsonb ? 'clé'`) et non en TypeScript :
 * c'est la base qui sait répondre, et ramener tous les canaux pour en écarter
 * la plupart serait du gâchis à chaque événement.
 */
export async function notificationChannelsForEvent(
  event: NotificationEventKey,
  db: Database = getDb(),
): Promise<NotificationChannelRecord[]> {
  const rows = await db
    .select()
    .from(notificationChannels)
    .where(
      and(
        eq(notificationChannels.enabled, true),
        sql`${notificationChannels.events} @> ${JSON.stringify([event])}::jsonb`,
      ),
    )
    .orderBy(notificationChannels.name);
  return rows.map(toRecord);
}

/** E-mail de l'acteur, pour la ligne « Déclenché par » du message. */
export async function notificationActorLabel(
  actorId: string | null,
  db: Database = getDb(),
): Promise<string | null> {
  if (!actorId) return null;
  const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, actorId));
  return row?.email ?? null;
}

// ─── écriture ─────────────────────────────────────────────────────────────────

export type NotificationChannelInput = {
  kind: NotificationChannelKind;
  name: string;
  enabled?: boolean;
  config: Record<string, unknown>;
  secrets: Record<string, unknown>;
  events: NotificationEventKey[];
};

/**
 * Trois cas distincts pour chaque secret, et ils doivent le rester :
 *   champ absent → inchangé
 *   `null`       → effacé
 *   chaîne       → remplacé
 * C'est la sémantique déjà retenue pour `aiApiKey` dans `settings.ts`.
 */
export type NotificationChannelPatch = {
  name?: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
  secrets?: Record<string, string | null>;
  events?: NotificationEventKey[];
};

function encodeSecrets(secrets: ChannelConfig): string | null {
  return Object.keys(secrets).length === 0 ? null : encrypt(JSON.stringify(secrets));
}

/**
 * La validation traverse le catalogue de `@pupitre/core` : c'est lui qui sait quels
 * champs un canal attend, lesquels sont obligatoires et lesquels sont secrets.
 * Un `ZodError` remonte tel quel à l'appelant — 422 côté route.
 */
function validate(
  kind: NotificationChannelKind,
  config: Record<string, unknown>,
  secrets: Record<string, unknown>,
): { config: ChannelConfig; secrets: ChannelConfig } {
  return {
    config: channelConfigSchema(kind).parse(config) as ChannelConfig,
    secrets: channelSecretsSchema(kind).parse(secrets) as ChannelConfig,
  };
}

export async function createNotificationChannel(
  input: NotificationChannelInput,
  actorId: string | null,
  db: Database = getDb(),
): Promise<NotificationChannelRecord> {
  const validated = validate(input.kind, input.config, input.secrets);

  try {
    const [row] = await db
      .insert(notificationChannels)
      .values({
        kind: input.kind,
        name: input.name,
        enabled: input.enabled ?? true,
        config: validated.config,
        encryptedSecrets: encodeSecrets(validated.secrets),
        events: input.events,
        createdBy: actorId,
      })
      .returning();
    if (!row) throw new Error('insertion du canal de notification sans retour');
    return toRecord(row);
  } catch (error) {
    if (isUniqueViolation(error)) throw new NotificationChannelNameTakenError(input.name);
    throw error;
  }
}

export async function updateNotificationChannel(
  id: string,
  patch: NotificationChannelPatch,
  db: Database = getDb(),
): Promise<NotificationChannelRecord | null> {
  const [current] = await db
    .select()
    .from(notificationChannels)
    .where(eq(notificationChannels.id, id));
  if (!current) return null;

  const nextConfigRaw = patch.config ?? current.config;

  // Fusion des secrets : on repart de ce qui est en base, on applique le patch
  // champ par champ, puis on **revalide l'ensemble**. Un secret obligatoire ne
  // peut donc pas être effacé au détour d'un enregistrement.
  const merged: Record<string, unknown> = { ...decodeSecrets(current.encryptedSecrets) };
  for (const [field, value] of Object.entries(patch.secrets ?? {})) {
    if (value === null || value === '') delete merged[field];
    else merged[field] = value;
  }

  const validated = validate(current.kind, nextConfigRaw, merged);

  try {
    const [row] = await db
      .update(notificationChannels)
      .set({
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
        ...(patch.events === undefined ? {} : { events: patch.events }),
        config: validated.config,
        encryptedSecrets: encodeSecrets(validated.secrets),
        updatedAt: new Date(),
      })
      .where(eq(notificationChannels.id, id))
      .returning();
    return row ? toRecord(row) : null;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new NotificationChannelNameTakenError(patch.name ?? current.name);
    }
    throw error;
  }
}

export async function deleteNotificationChannel(
  id: string,
  db: Database = getDb(),
): Promise<NotificationChannelRecord | null> {
  const [row] = await db
    .delete(notificationChannels)
    .where(eq(notificationChannels.id, id))
    .returning();
  return row ? toRecord(row) : null;
}

/**
 * Enregistre l'issue d'une tentative d'envoi.
 *
 * C'est la réponse à « l'échec ne doit pas être silencieux » : même quand
 * personne ne regarde le journal d'audit, l'écran des paramètres montre le
 * dernier message d'erreur et le nombre d'échecs d'affilée. `error` est déjà
 * expurgé par la couche d'envoi — aucun jeton n'atterrit ici.
 */
export async function recordNotificationOutcome(
  id: string,
  outcome: { ok: boolean; error?: string | null },
  db: Database = getDb(),
): Promise<void> {
  const now = new Date();
  await db
    .update(notificationChannels)
    .set(
      outcome.ok
        ? { lastSuccessAt: now, lastError: null, consecutiveFailures: 0 }
        : {
            lastFailureAt: now,
            lastError: (outcome.error ?? 'échec sans message').slice(0, 400),
            consecutiveFailures: sql`${notificationChannels.consecutiveFailures} + 1`,
          },
    )
    .where(eq(notificationChannels.id, id));
}
