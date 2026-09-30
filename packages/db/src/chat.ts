import type { ChatMention, ChatMessage } from '@pupitre/core';
import { and, asc, desc, eq, gt, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { getDb, type Database } from './client.js';
import { users } from './schema/auth.js';
import { chatMessages, chatReads } from './schema/chat.js';

/**
 * La discussion d'équipe : écrire, relire, effacer, compter les non-lus.
 *
 * Rien ici ne publie : c'est la route qui, une fois la ligne écrite, la pousse
 * sur le canal temps réel. La base reste la source de vérité — un onglet qui
 * se reconnecte relit l'historique, il ne compte pas sur le direct.
 */

const messageColumns = {
  id: chatMessages.id,
  channel: chatMessages.channel,
  authorId: chatMessages.authorId,
  authorName: users.name,
  body: chatMessages.body,
  mentions: chatMessages.mentions,
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
  createdAt: Date;
  deletedAt: Date | null;
};

export type StoredChatMessage = ChatMessage & { deleted: boolean };

function toMessage(row: MessageRow): StoredChatMessage {
  return {
    id: row.id,
    channel: row.channel,
    authorId: row.authorId,
    authorName: row.authorName,
    // Un message effacé ne rend plus rien de son contenu, même à qui le demande.
    body: row.deletedAt ? '' : row.body,
    mentions: row.deletedAt ? [] : row.mentions,
    createdAt: row.createdAt.toISOString(),
    deleted: row.deletedAt !== null,
  };
}

export async function insertChatMessage(
  input: { channel: string; authorId: string; body: string; mentions: ChatMention[] },
  db: Database = getDb(),
): Promise<StoredChatMessage> {
  const [created] = await db
    .insert(chatMessages)
    .values({
      channel: input.channel,
      authorId: input.authorId,
      body: input.body,
      mentions: input.mentions,
    })
    .returning({ id: chatMessages.id });
  if (!created) throw new Error("le message n'a pas été enregistré");
  const message = await getChatMessage(created.id, db);
  if (!message) throw new Error("le message n'a pas été relu");
  return message;
}

export async function getChatMessage(
  id: string,
  db: Database = getDb(),
): Promise<StoredChatMessage | null> {
  const [row] = await db
    .select(messageColumns)
    .from(chatMessages)
    .leftJoin(users, eq(users.id, chatMessages.authorId))
    .where(eq(chatMessages.id, id));
  return row ? toMessage(row) : null;
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
  return rows.reverse().map(toMessage);
}

/** Efface un message : la ligne reste, son contenu part. */
export async function deleteChatMessage(id: string, db: Database = getDb()): Promise<boolean> {
  const rows = await db
    .update(chatMessages)
    .set({ deletedAt: new Date(), body: '', mentions: [] })
    .where(and(eq(chatMessages.id, id), isNull(chatMessages.deletedAt)))
    .returning({ id: chatMessages.id });
  return rows.length > 0;
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

export type ChatMember = { id: string; name: string; email: string };

/** Les personnes qu'on peut mentionner : tous les comptes actifs. */
export async function listChatMembers(db: Database = getDb()): Promise<ChatMember[]> {
  return db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(eq(users.banned, false))
    .orderBy(asc(users.name));
}
