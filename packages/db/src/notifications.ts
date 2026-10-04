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
 * Access to the notification channels.
 *
 * Absolute rule, modeled on `targets.ts` and `settings.ts`: `encrypted_secrets`
 * only leaves here through `resolveNotificationChannel()`. Every other read
 * returns a `NotificationChannelRecord`, where the secrets simply do not exist —
 * only the **list of filled-in fields**. A secret therefore cannot leak by a
 * forgotten filter in a handler: it is not there.
 */

export type NotificationChannelRow = typeof notificationChannels.$inferSelect;

/** What leaves here toward a route, a screen or a log. Never a secret. */
export type NotificationChannelRecord = {
  id: string;
  kind: NotificationChannelKind;
  name: string;
  enabled: boolean;
  config: ChannelConfig;
  events: NotificationEventKey[];
  /** Names of the secret fields really filled in. Never their value. */
  configuredSecrets: string[];
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastError: string | null;
  consecutiveFailures: number;
  createdAt: Date;
  updatedAt: Date;
};

/** Name already taken. The database would refuse it anyway; we say it better. */
export class NotificationChannelNameTakenError extends Error {
  readonly channelName: string;

  constructor(channelName: string) {
    super(`Un canal nommé « ${channelName} » existe déjà`);
    this.name = 'NotificationChannelNameTakenError';
    this.channelName = channelName;
  }
}

/** Postgres code of a uniqueness constraint violation. */
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
    // `MASTER_KEY` changed, or damaged column. The channel stays "configured" — the
    // column is full — but nothing in it is readable. The real failure will happen
    // at send time, with an explicit message, rather than here where it would fail
    // a mere list display.
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
 * Complete configuration, secrets decrypted. The **only** decryption point.
 *
 * Reserved to the code that will really send — that is, the worker. The result
 * must neither be logged, nor go through an HTTP response, nor enter an audit
 * entry.
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
 * Active channels subscribed to this event.
 *
 * The filter on `events` is done in SQL (`jsonb ? 'key'`) and not in TypeScript:
 * it is the database that knows how to answer, and bringing back every channel
 * to discard most of them would be a waste at each event.
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

/** The actor's email, for the message's "Triggered by" line. */
export async function notificationActorLabel(
  actorId: string | null,
  db: Database = getDb(),
): Promise<string | null> {
  if (!actorId) return null;
  const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, actorId));
  return row?.email ?? null;
}

// ─── writing ──────────────────────────────────────────────────────────────────

export type NotificationChannelInput = {
  kind: NotificationChannelKind;
  name: string;
  enabled?: boolean;
  config: Record<string, unknown>;
  secrets: Record<string, unknown>;
  events: NotificationEventKey[];
};

/**
 * Three distinct cases for each secret, and they must stay so:
 *   field absent → unchanged
 *   `null`       → erased
 *   string       → replaced
 * It is the semantics already chosen for `aiApiKey` in `settings.ts`.
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
 * Validation goes through `@pupitre/core`'s catalog: it is what knows which
 * fields a channel expects, which are required and which are secret. A
 * `ZodError` goes up as is to the caller — 422 on the route side.
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
    if (!row) throw new Error('notification channel insert returned nothing');
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

  // Merging secrets: we start from what is in the database, apply the patch field
  // by field, then **validate the whole again**. A required secret therefore
  // cannot be erased in passing during a save.
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
 * Records the outcome of a send attempt.
 *
 * It is the answer to "the failure must not be silent": even when nobody looks
 * at the audit log, the settings screen shows the last error message and the
 * number of failures in a row. `error` is already scrubbed by the send layer —
 * no token lands here.
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
            // A failure without a message is still a failure: a dash rather than a frozen
            // sentence.
            lastError: (outcome.error ?? '—').slice(0, 400),
            consecutiveFailures: sql`${notificationChannels.consecutiveFailures} + 1`,
          },
    )
    .where(eq(notificationChannels.id, id));
}
