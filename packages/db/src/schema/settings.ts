import type { AppSettings } from '@pupitre/core';
import { DEFAULT_APP_SETTINGS } from '@pupitre/core';
import { sql } from 'drizzle-orm';
import { check, jsonb, pgTable, smallint, text, timestamp } from 'drizzle-orm/pg-core';
import { users } from './auth.js';

/**
 * Instance settings. **A single row**, `id = 1`.
 *
 * The singleton is held by the database (`primary key` + `check (id = 1)`) and
 * not by a TypeScript convention: impossible to insert a second row, even in SQL
 * by hand, hence impossible to have two competing configurations depending on
 * the read order.
 *
 * `value` is a single JSONB rather than one column per setting: adding a setting
 * then costs no migration. `@pupitre/core`'s Zod schema (`appSettingsSchema`)
 * stays the only source of truth about its shape.
 */
export const appSettings = pgTable(
  'app_settings',
  {
    id: smallint('id').primaryKey(),
    value: jsonb('value').$type<AppSettings>().notNull().default(DEFAULT_APP_SETTINGS),
    /**
     * The AI provider's API key, AES-256-GCM under `MASTER_KEY`,
     * `version:iv:authTag:ciphertext` format — the same pattern as
     * `targets.encrypted_credential`.
     *
     * A dedicated column and not a `value` field: a secret does not travel with
     * ordinary configuration. The whole JSONB can be serialized into a response or
     * an audit entry without risk, precisely because the key is not in it.
     */
    aiApiKeyEncrypted: text('ai_api_key_encrypted'),
    /**
     * The OpenID Connect client secret (single sign-on), same encryption and same
     * storage as the AI key: outside `value`, which is read, returned and written to
     * the log without exposing anything.
     */
    ssoClientSecretEncrypted: text('sso_client_secret_encrypted'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * `text` and not `uuid`: `users.id` is a Better Auth identifier, of type `text`.
     * The foreign key imposes the same type as the referenced column.
     */
    updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [check('app_settings_singleton_check', sql`${t.id} = 1`)],
);
