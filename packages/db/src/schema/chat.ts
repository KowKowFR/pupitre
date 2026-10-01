import type { ChatMention } from '@pupitre/core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { ImageMediaType } from '@pupitre/core';
import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { bytea } from './columns.js';

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
    /**
     * Le message auquel celui-ci répond. `set null` : si l'original disparaît
     * de la base, la réponse reste, sans citation — mais un effacement doux
     * garde la ligne, et la citation dit alors « message supprimé ».
     */
    replyToId: uuid('reply_to_id').references((): AnyPgColumn => chatMessages.id, {
      onDelete: 'set null',
    }),
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

/**
 * Les réactions : un emoji, une personne, un message. La clé primaire fait
 * qu'on ne réagit qu'une fois avec le même emoji — cliquer à nouveau retire.
 */
export const chatReactions = pgTable(
  'chat_reactions',
  {
    messageId: uuid('message_id')
      .notNull()
      .references(() => chatMessages.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    emoji: text('emoji').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.userId, t.emoji] }),
    index('chat_reactions_message_idx').on(t.messageId),
  ],
);

/**
 * Les images jointes à un message.
 *
 * En base, comme les captures de la supervision, et pour la même raison : une
 * seule chose à sauvegarder, pas de volume partagé entre le panel et le worker.
 * Le coût est borné à l'entrée — quatre images par message, trois mégaoctets
 * chacune au plus, réencodées par le navigateur (voir `media.ts` dans
 * `@pupitre/core`) — et à la sortie : effacer le message efface ses images,
 * pas seulement leur affichage.
 *
 * ⚠ `data` ne part jamais dans un `select *` : le fil ne lit que les
 * métadonnées, la route `/api/chat/attachments/:id` seule lit les octets.
 */
export const chatAttachments = pgTable(
  'chat_attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => chatMessages.id, { onDelete: 'cascade' }),
    /** L'ordre d'affichage dans le message. */
    position: integer('position').notNull().default(0),
    /** Lu dans les octets à l'arrivée, jamais pris dans l'en-tête de la requête. */
    contentType: text('content_type').$type<ImageMediaType>().notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    bytes: integer('bytes').notNull(),
    data: bytea('data').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('chat_attachments_message_idx').on(t.messageId, t.position)],
);
