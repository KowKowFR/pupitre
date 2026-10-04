import type { AppSettings, AppSettingsPatch, OnboardingState } from '@pupitre/core';
import {
  DEFAULT_APP_SETTINGS,
  appSettingsSchema,
  encrypt,
  decrypt,
  mergeAppSettings,
  parseAppSettings,
} from '@pupitre/core';
import { eq } from 'drizzle-orm';
import { getDb, type Database } from './client.js';
import { appSettings } from './schema/settings.js';

/**
 * Access to the instance settings.
 *
 * Absolute rule, modeled on `targets.ts`: `ai_api_key_encrypted` only leaves here
 * through `getAiApiKey()`, `sso_client_secret_encrypted` only through
 * `getSsoClientSecret()`. Every other read returns an `AppSettingsRecord`, where
 * the key simply does not exist — only the fact that it is set and its last four
 * characters. The secret therefore cannot leak by a forgotten filter in a
 * handler.
 */

/** Single row. The singleton is guaranteed by the database (`check (id = 1)`). */
const SINGLETON_ID = 1;

export type AppSettingsRecord = {
  settings: AppSettings;
  /** Is a key saved? Never the key itself. */
  aiApiKeyConfigured: boolean;
  /** Last four characters, to recognize the key without revealing it. */
  aiApiKeyLast4: string | null;
  /** Is an OpenID Connect client secret saved? Never the secret. */
  ssoClientSecretConfigured: boolean;
  updatedAt: Date | null;
  updatedBy: string | null;
};

const EMPTY_RECORD: AppSettingsRecord = {
  settings: DEFAULT_APP_SETTINGS,
  aiApiKeyConfigured: false,
  aiApiKeyLast4: null,
  ssoClientSecretConfigured: false,
  updatedAt: null,
  updatedBy: null,
};

/**
 * Very short in-memory cache.
 *
 * Each page render reads the settings — the instance's name at the top left, the
 * time zone of each date. One SQL query per render would be a waste for a row
 * that changes three times a year. Five seconds are enough to absorb a page
 * load's burst without a setting visibly taking time to appear.
 *
 * The cache is **per process**: the panel and the worker each have their own. A
 * write invalidates the writing process's; the other catches up at the latest
 * after the TTL. That is acceptable here — none of these settings is a security
 * decision, and nothing depends on consistency to the second.
 *
 * It is, however, carried by `globalThis`, and not by a plain module variable.
 * Next splits the server code into chunks and may load **several copies** of
 * this module — one for a Route Handler, one for a layout. With a module
 * variable, each copy would have its own cache: a write through the API would
 * invalidate its own and leave the layout serving the old value for the whole
 * TTL. The observed symptom was a "restart the wizard" with no visible effect
 * for five seconds. `globalThis` is shared by all copies; it is the pattern
 * already chosen in this repository for the BullMQ queues, and for the same
 * reason.
 */
const CACHE_TTL_MS = 5_000;

type CacheEntry = { record: AppSettingsRecord; expiresAt: number };

declare global {
  var __tpAppSettingsCache: CacheEntry | null | undefined;
}

function readCache(): CacheEntry | null {
  return globalThis.__tpAppSettingsCache ?? null;
}

function writeCache(entry: CacheEntry): void {
  globalThis.__tpAppSettingsCache = entry;
}

/** Empties the cache. Called at each write, and by the tests. */
export function invalidateAppSettingsCache(): void {
  globalThis.__tpAppSettingsCache = null;
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
      // Unreadable key (MASTER_KEY changed): it stays "configured" — the column is
      // full — but we show nothing of it. The real decryption will fail when it is
      // used, with an explicit message.
      aiApiKeyLast4 = null;
    }
  }

  return {
    settings: parseAppSettings(row.value),
    aiApiKeyConfigured: row.aiApiKeyEncrypted !== null,
    aiApiKeyLast4,
    ssoClientSecretConfigured: row.ssoClientSecretEncrypted !== null,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}

/**
 * Read. Never throws because the row is missing or incomplete: an empty
 * database returns the schema's defaults.
 */
export async function getAppSettings(db: Database = getDb()): Promise<AppSettingsRecord> {
  const now = Date.now();
  const cached = readCache();
  if (cached && cached.expiresAt > now) return cached.record;

  const [row] = await db.select().from(appSettings).where(eq(appSettings.id, SINGLETON_ID));
  const record = toRecord(row);
  writeCache({ record, expiresAt: now + CACHE_TTL_MS });
  return record;
}

/** Shortcut: only the settings, without the key's metadata. */
export async function getAppSettingsValue(db: Database = getDb()): Promise<AppSettings> {
  return (await getAppSettings(db)).settings;
}

/**
 * API key in clear. The **only** decryption point.
 * Reserved to the server code that will really call the provider; the result
 * must neither be logged nor go through an HTTP response.
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
 * Three distinct cases for the key, and they must stay so:
 *   field absent  → unchanged
 *   `null`        → erased
 *   string        → replaced
 * Hence the property existence test rather than a comparison with `undefined`,
 * which would confuse "absent" and "explicitly empty".
 */
/** The OpenID Connect client secret, decrypted — to build the provider, nothing else. */
export async function getSsoClientSecret(db: Database = getDb()): Promise<string | null> {
  const [row] = await db
    .select({ encrypted: appSettings.ssoClientSecretEncrypted })
    .from(appSettings)
    .where(eq(appSettings.id, SINGLETON_ID));

  if (!row?.encrypted) return null;
  return decrypt(row.encrypted);
}

export type AppSettingsUpdate = AppSettingsPatch & {
  aiApiKey?: string | null;
  ssoClientSecret?: string | null;
};

/** What a write did to the key — enough to write the audit entry. */
export type AiApiKeyChange = 'unchanged' | 'set' | 'cleared';

export type AppSettingsUpdateResult = {
  before: AppSettingsRecord;
  after: AppSettingsRecord;
  keyChange: AiApiKeyChange;
  ssoSecretChange: AiApiKeyChange;
};

/**
 * Shallow merge, Zod validation, upsert on the single row. Validation happens
 * *before* the write: a made-up time zone never reaches the database, and the
 * Zod error goes up as is to the caller (422 on the API side).
 */
export async function updateAppSettings(
  patch: AppSettingsUpdate,
  actorId: string | null,
  db: Database = getDb(),
): Promise<AppSettingsUpdateResult> {
  const { aiApiKey, ssoClientSecret, ...settingsPatch } = patch;
  const keyProvided = Object.hasOwn(patch, 'aiApiKey');
  const ssoSecretProvided = Object.hasOwn(patch, 'ssoClientSecret');

  // Direct read, bypassing the cache: a write must start from the state really in
  // the database, not from a five-second-old snapshot.
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

  let encryptedSsoSecret: string | null = currentRow?.ssoClientSecretEncrypted ?? null;
  let ssoSecretChange: AiApiKeyChange = 'unchanged';
  if (ssoSecretProvided) {
    if (ssoClientSecret === null || ssoClientSecret === undefined) {
      encryptedSsoSecret = null;
      ssoSecretChange = 'cleared';
    } else {
      encryptedSsoSecret = encrypt(ssoClientSecret);
      ssoSecretChange = 'set';
    }
  }

  const [row] = await db
    .insert(appSettings)
    .values({
      id: SINGLETON_ID,
      value,
      aiApiKeyEncrypted: encryptedKey,
      ssoClientSecretEncrypted: encryptedSsoSecret,
      updatedAt: new Date(),
      updatedBy: actorId,
    })
    .onConflictDoUpdate({
      target: appSettings.id,
      set: {
        value,
        aiApiKeyEncrypted: encryptedKey,
        ssoClientSecretEncrypted: encryptedSsoSecret,
        updatedAt: new Date(),
        updatedBy: actorId,
      },
    })
    .returning();

  invalidateAppSettingsCache();
  return { before, after: toRecord(row), keyChange, ssoSecretChange };
}

/**
 * Write reserved to advancing the getting-started wizard.
 *
 * Separate from `updateAppSettings()` for two reasons. First the surface:
 * `appSettingsPatchSchema` does not carry `onboarding`, precisely so that the
 * settings screen cannot declare a journey finished in passing during a time
 * zone change. Second the API key: the read-modify is done here on the JSONB
 * alone, the encrypted column is not touched — not even rewritten identically,
 * which would put it at the mercy of a missing `MASTER_KEY`.
 *
 * The transformation is passed as a function rather than a value: the
 * transition lives in `@pupitre/core` (`applyOnboardingAction`), and the caller
 * cannot write a state it would have made up beside the rules.
 */
export async function updateOnboardingState(
  apply: (current: OnboardingState) => OnboardingState,
  actorId: string | null,
  db: Database = getDb(),
): Promise<{ before: OnboardingState; after: OnboardingState }> {
  // Direct read: a write starts from the real state, never from the cache.
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
      // `aiApiKeyEncrypted` is absent from the `set`: the saved key survives each step
      // of the wizard without ever going through this path.
      set: { value, updatedAt: new Date(), updatedBy: actorId },
    });

  invalidateAppSettingsCache();
  return { before: current.onboarding, after };
}
