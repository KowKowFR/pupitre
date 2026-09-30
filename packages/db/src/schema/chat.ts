import type { ChatMention } from '@pupitre/core';
import { index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';

/**
 * La discussion d'équipe.
 *
 * Un message effacé garde sa ligne (`deleted_at`) : le fil ne se recoud pas
 * dans le dos de ceux qui l'ont lu, et « message supprimé » reste une
 * information. Son corps, lui, est vidé à l'effacement.
 */
export const chatMessages = pgTable(
  'chat_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Un seul salon pour l'instant, `general` ; la colonne prépare les suivants. */
    channel: text('channel').notNull().default('general'),
    /** `null` : l'auteur a été supprimé. Le message reste, anonyme. */
    authorId: text('author_id').references(() => users.id, { onDelete: 'set null' }),
    /** Texte brut, mentions en jetons `<@kind:id>`. Jamais de HTML. */
    body: text('body').notNull(),
    mentions: jsonb('mentions').$type<ChatMention[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [index('chat_messages_channel_created_idx').on(t.channel, t.createdAt)],
);

/** Jusqu'où chacun a lu, par salon : de quoi compter les non-lus. */
export const chatReads = pgTable(
  'chat_reads',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull(),
    lastReadAt: timestamp('last_read_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.channel] })],
);
