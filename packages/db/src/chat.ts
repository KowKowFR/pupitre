import {
  CHAT_QUOTE_LENGTH,
  CHAT_REACTIONS_MAX,
  chatPlainText,
  type ChatAttachment,
  type ChatMention,
  type ChatMessage,
  type ChatQuote,
  type ChatReaction,
} from '@pupitre/core';
import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { getDb, type Database } from './client.js';
import { users } from './schema/auth.js';
import { chatAttachments, chatMessages, chatReactions, chatReads } from './schema/chat.js';

/**
 * The team chat: write, reply, react, read, erase, count the unread.
 *
 * Nothing here publishes: it is the route that, once the row is written, pushes
 * it on the real-time channel. The database stays the source of truth — a tab
 * that reconnects reads the history again, it does not count on the live feed.
 *
 * A page of messages costs four queries, whatever its size: the messages, the
 * originals they quote, their reactions, their images (the metadata only — the
 * bytes are served separately).
 */

const messageColumns = {
  id: chatMessages.id,
  channel: chatMessages.channel,
  authorId: chatMessages.authorId,
  authorName: users.name,
  body: chatMessages.body,
  mentions: chatMessages.mentions,
  replyToId: chatMessages.replyToId,
  createdAt: chatMessages.createdAt,
  deletedAt: chatMessages.deletedAt,
};

type MessageRow = {
  id: string;
  channel: string;
  authorId: string | null;
  authorName: string | null;
  body: string;
  mentions: ChatMention[];
  replyToId: string | null;
  createdAt: Date;
  deletedAt: Date | null;
};

export type StoredChatMessage = ChatMessage & { deleted: boolean };

function quoteOf(row: MessageRow): ChatQuote {
  const text = row.deletedAt ? '' : chatPlainText(row.body, row.mentions).replace(/\s+/g, ' ');
  return {
    id: row.id,
    authorId: row.authorId,
    authorName: row.authorName,
    excerpt: text.length > CHAT_QUOTE_LENGTH ? `${text.slice(0, CHAT_QUOTE_LENGTH - 1)}…` : text,
    deleted: row.deletedAt !== null,
  };
}

/** The reactions of several messages, grouped by emoji in order of arrival. */
export async function listChatReactions(
  messageIds: readonly string[],
  db: Database = getDb(),
): Promise<Map<string, ChatReaction[]>> {
  const byMessage = new Map<string, ChatReaction[]>();
  if (messageIds.length === 0) return byMessage;
  const rows = await db
    .select({
      messageId: chatReactions.messageId,
      emoji: chatReactions.emoji,
      userId: chatReactions.userId,
    })
    .from(chatReactions)
    .where(inArray(chatReactions.messageId, [...messageIds]))
    .orderBy(asc(chatReactions.createdAt));
  for (const row of rows) {
    const reactions = byMessage.get(row.messageId) ?? [];
    const existing = reactions.find((reaction) => reaction.emoji === row.emoji);
    if (existing) existing.userIds.push(row.userId);
    else reactions.push({ emoji: row.emoji, userIds: [row.userId] });
    byMessage.set(row.messageId, reactions);
  }
  return byMessage;
}

/** The images of several messages, without their bytes, in display order. */
export async function listChatAttachments(
  messageIds: readonly string[],
  db: Database = getDb(),
): Promise<Map<string, ChatAttachment[]>> {
  const byMessage = new Map<string, ChatAttachment[]>();
  if (messageIds.length === 0) return byMessage;
  const rows = await db
    .select({
      id: chatAttachments.id,
      messageId: chatAttachments.messageId,
      contentType: chatAttachments.contentType,
      width: chatAttachments.width,
      height: chatAttachments.height,
      bytes: chatAttachments.bytes,
    })
    .from(chatAttachments)
    .where(inArray(chatAttachments.messageId, [...messageIds]))
    .orderBy(asc(chatAttachments.position));
  for (const { messageId, ...attachment } of rows) {
    const list = byMessage.get(messageId) ?? [];
    list.push(attachment);
    byMessage.set(messageId, list);
  }
  return byMessage;
}

async function hydrate(rows: MessageRow[], db: Database): Promise<StoredChatMessage[]> {
  const quotedIds = [...new Set(rows.flatMap((row) => (row.replyToId ? [row.replyToId] : [])))];
  const live = rows.filter((row) => row.deletedAt === null).map((row) => row.id);
  const [quoted, reactions, attachments] = await Promise.all([
    quotedIds.length > 0
      ? db
          .select(messageColumns)
          .from(chatMessages)
          .leftJoin(users, eq(users.id, chatMessages.authorId))
          .where(inArray(chatMessages.id, quotedIds))
      : Promise.resolve([] as MessageRow[]),
    listChatReactions(
      rows.map((row) => row.id),
      db,
    ),
    listChatAttachments(live, db),
  ]);
  const quotes = new Map(quoted.map((row) => [row.id, quoteOf(row)]));

  return rows.map((row) => ({
    id: row.id,
    channel: row.channel,
    authorId: row.authorId,
    authorName: row.authorName,
    // An erased message no longer returns anything of its content, even to whoever
    // asks.
    body: row.deletedAt ? '' : row.body,
    mentions: row.deletedAt ? [] : row.mentions,
    replyTo: row.replyToId ? (quotes.get(row.replyToId) ?? null) : null,
    reactions: row.deletedAt ? [] : (reactions.get(row.id) ?? []),
    attachments: row.deletedAt ? [] : (attachments.get(row.id) ?? []),
    createdAt: row.createdAt.toISOString(),
    deleted: row.deletedAt !== null,
  }));
}

export type NewChatAttachment = Omit<ChatAttachment, 'id'> & { data: Buffer };

/** The message and its images, in the same transaction: never one without the others. */
export async function insertChatMessage(
  input: {
    channel: string;
    authorId: string;
    body: string;
    mentions: ChatMention[];
    replyToId: string | null;
    attachments?: NewChatAttachment[];
  },
  db: Database = getDb(),
): Promise<StoredChatMessage> {
  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(chatMessages)
      .values({
        channel: input.channel,
        authorId: input.authorId,
        body: input.body,
        mentions: input.mentions,
        replyToId: input.replyToId,
      })
      .returning({ id: chatMessages.id });
    if (!row) throw new Error('the message was not saved');
    const attachments = input.attachments ?? [];
    if (attachments.length > 0) {
      await tx
        .insert(chatAttachments)
        .values(
          attachments.map((attachment, position) => ({
            ...attachment,
            messageId: row.id,
            position,
          })),
        );
    }
    return row;
  });
  const message = await getChatMessage(created.id, db);
  if (!message) throw new Error('the message could not be read back');
  return message;
}

export async function getChatMessage(
  id: string,
  db: Database = getDb(),
): Promise<StoredChatMessage | null> {
  const rows = await db
    .select(messageColumns)
    .from(chatMessages)
    .leftJoin(users, eq(users.id, chatMessages.authorId))
    .where(eq(chatMessages.id, id));
  const [message] = await hydrate(rows, db);
  return message ?? null;
}

/**
 * A page of the thread, from oldest to newest. `before` goes back in time: the
 * previous page starts just before the oldest message shown.
 */
export async function listChatMessages(
  channel: string,
  options: { before?: Date; limit: number },
  db: Database = getDb(),
): Promise<StoredChatMessage[]> {
  const rows = await db
    .select(messageColumns)
    .from(chatMessages)
    .leftJoin(users, eq(users.id, chatMessages.authorId))
    .where(
      and(
        eq(chatMessages.channel, channel),
        options.before ? lt(chatMessages.createdAt, options.before) : undefined,
      ),
    )
    .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
    .limit(options.limit);
  return hydrate(rows.reverse(), db);
}

export type ReactionToggle =
  { ok: true; reactions: ChatReaction[] } | { ok: false; reason: 'not_found' | 'too_many' };

/**
 * Sets the reaction, or removes it if it is already there: the same gesture both
 * ways, as everywhere else. An erased message can no longer be reacted to.
 */
export async function toggleChatReaction(
  messageId: string,
  userId: string,
  emoji: string,
  db: Database = getDb(),
): Promise<ReactionToggle> {
  const [message] = await db
    .select({ id: chatMessages.id, deletedAt: chatMessages.deletedAt })
    .from(chatMessages)
    .where(eq(chatMessages.id, messageId));
  if (!message || message.deletedAt) return { ok: false, reason: 'not_found' };

  const removed = await db
    .delete(chatReactions)
    .where(
      and(
        eq(chatReactions.messageId, messageId),
        eq(chatReactions.userId, userId),
        eq(chatReactions.emoji, emoji),
      ),
    )
    .returning({ emoji: chatReactions.emoji });

  if (removed.length === 0) {
    const current = (await listChatReactions([messageId], db)).get(messageId) ?? [];
    const known = current.some((reaction) => reaction.emoji === emoji);
    if (!known && current.length >= CHAT_REACTIONS_MAX) return { ok: false, reason: 'too_many' };
    await db.insert(chatReactions).values({ messageId, userId, emoji }).onConflictDoNothing();
  }
  const reactions = (await listChatReactions([messageId], db)).get(messageId) ?? [];
  return { ok: true, reactions };
}

/**
 * Erases a message: the row stays, its content, its reactions and its images go
 * — the bytes with them, not only their display.
 */
export async function deleteChatMessage(id: string, db: Database = getDb()): Promise<boolean> {
  const rows = await db
    .update(chatMessages)
    .set({ deletedAt: new Date(), body: '', mentions: [] })
    .where(and(eq(chatMessages.id, id), isNull(chatMessages.deletedAt)))
    .returning({ id: chatMessages.id });
  if (rows.length > 0) {
    await db.delete(chatReactions).where(eq(chatReactions.messageId, id));
    await db.delete(chatAttachments).where(eq(chatAttachments.messageId, id));
  }
  return rows.length > 0;
}

/** An image's bytes, for the route that serves it — and that route alone. */
export async function getChatAttachmentData(
  id: string,
  db: Database = getDb(),
): Promise<{ contentType: ChatAttachment['contentType']; bytes: number; data: Buffer } | null> {
  const [row] = await db
    .select({
      contentType: chatAttachments.contentType,
      bytes: chatAttachments.bytes,
      data: chatAttachments.data,
    })
    .from(chatAttachments)
    .innerJoin(chatMessages, eq(chatMessages.id, chatAttachments.messageId))
    .where(and(eq(chatAttachments.id, id), isNull(chatMessages.deletedAt)));
  return row ?? null;
}

/** Marks the room read up to `at` — never backward. */
export async function markChatRead(
  userId: string,
  channel: string,
  at: Date,
  db: Database = getDb(),
): Promise<void> {
  await db
    .insert(chatReads)
    .values({ userId, channel, lastReadAt: at })
    .onConflictDoUpdate({
      target: [chatReads.userId, chatReads.channel],
      set: { lastReadAt: sql`greatest(${chatReads.lastReadAt}, excluded.last_read_at)` },
    });
}

export async function getChatReadMarker(
  userId: string,
  channel: string,
  db: Database = getDb(),
): Promise<Date | null> {
  const [row] = await db
    .select({ lastReadAt: chatReads.lastReadAt })
    .from(chatReads)
    .where(and(eq(chatReads.userId, userId), eq(chatReads.channel, channel)));
  return row?.lastReadAt ?? null;
}

/** The others' messages, arrived since the last read. */
export async function countUnreadChat(
  userId: string,
  channel: string,
  db: Database = getDb(),
): Promise<number> {
  const marker = await getChatReadMarker(userId, channel, db);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.channel, channel),
        isNull(chatMessages.deletedAt),
        or(isNull(chatMessages.authorId), ne(chatMessages.authorId, userId)),
        marker ? gt(chatMessages.createdAt, marker) : undefined,
      ),
    );
  return row?.count ?? 0;
}

/**
 * Among the unread, those addressed to the person: a mention, or a reply to one
 * of their messages. They are the ones that color the bubble.
 */
export async function countUnreadChatMentions(
  userId: string,
  channel: string,
  db: Database = getDb(),
): Promise<number> {
  const marker = await getChatReadMarker(userId, channel, db);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.channel, channel),
        isNull(chatMessages.deletedAt),
        or(isNull(chatMessages.authorId), ne(chatMessages.authorId, userId)),
        marker ? gt(chatMessages.createdAt, marker) : undefined,
        or(
          sql`${chatMessages.mentions} @> ${JSON.stringify([{ kind: 'user', id: userId }])}::jsonb`,
          sql`${chatMessages.replyToId} in (select ${chatMessages.id} from ${chatMessages} where ${chatMessages.authorId} = ${userId})`,
        ),
      ),
    );
  return row?.count ?? 0;
}

export type ChatMember = { id: string; name: string; email: string; image: string | null };

/** The people who can be mentioned: every active account. */
export async function listChatMembers(db: Database = getDb()): Promise<ChatMember[]> {
  return db
    .select({ id: users.id, name: users.name, email: users.email, image: users.image })
    .from(users)
    .where(eq(users.banned, false))
    .orderBy(asc(users.name));
}
