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
 * The team chat.
 *
 * An erased message keeps its row (`deleted_at`): the thread is not stitched up
 * behind the backs of those who read it, and "message deleted" stays
 * information. Its body is emptied at erasure.
 */
export const chatMessages = pgTable(
  'chat_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** A single room for now, `general`; the column prepares the next ones. */
    channel: text('channel').notNull().default('general'),
    /** `null`: the author was deleted. The message stays, anonymous. */
    authorId: text('author_id').references(() => users.id, { onDelete: 'set null' }),
    /** Plain text, mentions as `<@kind:id>` tokens. Never HTML. */
    body: text('body').notNull(),
    mentions: jsonb('mentions').$type<ChatMention[]>().notNull().default([]),
    /**
     * The message this one replies to. `set null`: if the original disappears from
     * the database, the reply stays, without a quote — but a soft erasure keeps the
     * row, and the quote then says "message deleted".
     */
    replyToId: uuid('reply_to_id').references((): AnyPgColumn => chatMessages.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [index('chat_messages_channel_created_idx').on(t.channel, t.createdAt)],
);

/** How far each person has read, per room: enough to count the unread. */
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
 * The reactions: an emoji, a person, a message. The primary key means one only
 * reacts once with the same emoji — clicking again removes it.
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
 * The images attached to a message.
 *
 * In the database, like monitoring's captures, and for the same reason: a single
 * thing to back up, no volume shared between the panel and the worker. The cost
 * is bounded on the way in — four images per message, three megabytes each at
 * most, re-encoded by the browser (see `media.ts` in `@pupitre/core`) — and on
 * the way out: erasing the message erases its images, not only their display.
 *
 * ⚠ `data` never goes out in a `select *`: the thread only reads the metadata,
 * the `/api/chat/attachments/:id` route alone reads the bytes.
 */
export const chatAttachments = pgTable(
  'chat_attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => chatMessages.id, { onDelete: 'cascade' }),
    /** The display order in the message. */
    position: integer('position').notNull().default(0),
    /** Read from the bytes on arrival, never taken from the request's header. */
    contentType: text('content_type').$type<ImageMediaType>().notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    bytes: integer('bytes').notNull(),
    data: bytea('data').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('chat_attachments_message_idx').on(t.messageId, t.position)],
);
