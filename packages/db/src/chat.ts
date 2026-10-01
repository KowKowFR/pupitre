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
 * La discussion d'équipe : écrire, répondre, réagir, relire, effacer, compter
 * les non-lus.
 *
 * Rien ici ne publie : c'est la route qui, une fois la ligne écrite, la pousse
 * sur le canal temps réel. La base reste la source de vérité — un onglet qui
 * se reconnecte relit l'historique, il ne compte pas sur le direct.
 *
 * Une page de messages coûte quatre requêtes, quelle que soit sa taille : les
 * messages, les originaux qu'ils citent, leurs réactions, leurs images (les
 * métadonnées seulement — les octets se servent à part).
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

/** Les réactions de plusieurs messages, groupées par emoji dans l'ordre d'arrivée. */
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

/** Les images de plusieurs messages, sans leurs octets, dans l'ordre d'affichage. */
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
    // Un message effacé ne rend plus rien de son contenu, même à qui le demande.
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

/** Le message et ses images, dans la même transaction : jamais l'un sans les autres. */
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
    if (!row) throw new Error("le message n'a pas été enregistré");
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
  if (!message) throw new Error("le message n'a pas été relu");
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
 * Une page du fil, du plus ancien au plus récent. `before` remonte le temps :
 * la page d'avant commence juste avant le plus ancien message affiché.
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
 * Pose la réaction, ou la retire si elle y est déjà : le même geste dans les
 * deux sens, comme partout ailleurs. Un message effacé ne se réagit plus.
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
 * Efface un message : la ligne reste, son contenu, ses réactions et ses images
 * partent — les octets avec, pas seulement leur affichage.
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

/** Les octets d'une image, pour la route qui la sert — et elle seule. */
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

/** Marque le salon lu jusqu'à `at` — jamais en arrière. */
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

/** Les messages des autres, arrivés depuis la dernière lecture. */
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
 * Parmi les non-lus, ceux qui s'adressent à la personne : une mention, ou une
 * réponse à l'un de ses messages. Ce sont eux qui colorent la bulle.
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

/** Les personnes qu'on peut mentionner : tous les comptes actifs. */
export async function listChatMembers(db: Database = getDb()): Promise<ChatMember[]> {
  return db
    .select({ id: users.id, name: users.name, email: users.email, image: users.image })
    .from(users)
    .where(eq(users.banned, false))
    .orderBy(asc(users.name));
}
