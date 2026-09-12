import type { AppSettings } from '@pupitre/core';
import { DEFAULT_APP_SETTINGS } from '@pupitre/core';
import { sql } from 'drizzle-orm';
import { check, jsonb, pgTable, smallint, text, timestamp } from 'drizzle-orm/pg-core';
import { users } from './auth.js';

/**
 * Paramètres de l'instance. **Une seule ligne**, `id = 1`.
 *
 * Le singleton est tenu par la base (`primary key` + `check (id = 1)`) et non
 * par une convention en TypeScript : impossible d'insérer une seconde ligne,
 * même en SQL à la main, donc impossible d'avoir deux configurations
 * concurrentes selon l'ordre de lecture.
 *
 * `value` est un JSONB unique plutôt qu'une colonne par réglage : ajouter un
 * paramètre ne coûte alors pas de migration. Le schéma Zod de `@pupitre/core`
 * (`appSettingsSchema`) reste la seule source de vérité sur sa forme.
 */
export const appSettings = pgTable(
  'app_settings',
  {
    id: smallint('id').primaryKey(),
    value: jsonb('value').$type<AppSettings>().notNull().default(DEFAULT_APP_SETTINGS),
    /**
     * Clé d'API du fournisseur d'IA, AES-256-GCM sous `MASTER_KEY`, format
     * `version:iv:authTag:ciphertext` — même motif que
     * `targets.encrypted_credential`.
     *
     * Colonne dédiée et non un champ de `value` : un secret ne voyage pas avec
     * de la configuration ordinaire. Le JSONB entier peut être sérialisé dans
     * une réponse ou une entrée d'audit sans risque, précisément parce que la
     * clé n'y est pas.
     */
    aiApiKeyEncrypted: text('ai_api_key_encrypted'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * `text` et non `uuid` : `users.id` est un identifiant Better Auth, de type
     * `text`. La clé étrangère impose le même type que la colonne référencée.
     */
    updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [check('app_settings_singleton_check', sql`${t.id} = 1`)],
);
