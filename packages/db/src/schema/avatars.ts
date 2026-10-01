import type { ImageMediaType } from '@pupitre/core';
import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { bytea } from './columns.js';

/**
 * La photo de profil de chaque personne, en base — pas de service de fichiers
 * à côté, rien de plus à sauvegarder que la base elle-même.
 *
 * Une ligne par personne au plus, remplacée à chaque envoi. La photo est petite
 * par construction : un carré de 256 px réencodé par le navigateur, 512 Kio au
 * plus (voir `media.ts` dans `@pupitre/core`).
 *
 * `users.image`, le champ que Better Auth porte dans la session, reçoit l'URL
 * **versionnée** de la photo (`/api/users/:id/avatar?v=…`) : chaque écran qui
 * connaît la personne connaît sa photo, et une nouvelle photo change d'URL —
 * le navigateur peut donc garder l'ancienne en cache aussi longtemps qu'il veut.
 */
export const userAvatars = pgTable('user_avatars', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** Lu dans les octets à l'arrivée, jamais pris dans l'en-tête de la requête. */
  contentType: text('content_type').$type<ImageMediaType>().notNull(),
  width: integer('width').notNull(),
  height: integer('height').notNull(),
  bytes: integer('bytes').notNull(),
  data: bytea('data').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
