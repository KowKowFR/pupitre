import {
  CHAT_DEFAULT_CHANNEL,
  CHAT_MESSAGE_MAX,
  CHAT_PAGE_SIZE,
  keepMentions,
} from '@pupitre/core';
import { getChatMessage, insertChatMessage, listChatMessages, markChatRead } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { chat as messages } from '@/i18n/messages/chat';
import { resolveMentions } from '@/lib/chat';
import { HttpError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { enforceRateLimit, type RateLimitRule } from '@/lib/rate-limit';
import { requireSession } from '@/lib/rbac';
import { publishRealtime } from '@/lib/realtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Assez pour une conversation vive, trop peu pour noyer le fil. */
const CHAT_POST_RULE: RateLimitRule = { name: 'chat:post', limit: 20, windowSec: 30 };

const querySchema = z.object({
  before: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(CHAT_PAGE_SIZE),
});

/** Une page du fil, la plus récente d'abord demandée, rendue dans l'ordre de lecture. */
export const GET = apiRoute(async (request) => {
  await requireSession(request);
  const query = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
  const items = await listChatMessages(CHAT_DEFAULT_CHANNEL, query);
  return NextResponse.json({ items, hasMore: items.length === query.limit });
});

const bodySchema = z.object({
  body: z.string().max(CHAT_MESSAGE_MAX * 2),
  /** Le message auquel on répond. Il doit exister, dans ce salon, et ne pas être effacé. */
  replyToId: z.string().uuid().nullable().default(null),
});

/**
 * Écrire à l'équipe. Les mentions sont revérifiées ici : un jeton vers ce que
 * l'auteur ne peut pas ouvrir redevient du texte. Le message est enregistré,
 * puis poussé en direct — la base d'abord, pour qu'un onglet qui se
 * reconnecte au même instant le relise.
 *
 * Pas de ligne d'audit : un message n'est pas une action sur le parc, et le
 * journal ne doit pas se noyer dans la conversation. L'effacement d'un
 * message d'autrui, lui, est tracé.
 */
export const POST = apiRoute(async (request) => {
  const auth = await requireSession(request);
  await enforceRateLimit(CHAT_POST_RULE, auth.userId);
  const input = await readJsonBody(request, bodySchema);

  const raw = input.body.replace(/\r\n?/g, '\n').trim();
  if (raw.length === 0) throw new HttpError(422, 'empty_message', msg(messages, 'error.empty'));
  if (raw.length > CHAT_MESSAGE_MAX) {
    throw new HttpError(
      422,
      'message_too_long',
      msg(messages, 'error.tooLong', { max: CHAT_MESSAGE_MAX }),
    );
  }

  if (input.replyToId) {
    const original = await getChatMessage(input.replyToId);
    if (!original || original.deleted || original.channel !== CHAT_DEFAULT_CHANNEL) {
      throw new NotFoundError(msg(messages, 'error.replyNotFound'));
    }
  }

  const mentions = await resolveMentions(raw, auth);
  const body = keepMentions(raw, mentions);
  const message = await insertChatMessage({
    channel: CHAT_DEFAULT_CHANNEL,
    authorId: auth.userId,
    body,
    mentions,
    replyToId: input.replyToId,
  });
  await markChatRead(auth.userId, CHAT_DEFAULT_CHANNEL, new Date(message.createdAt));

  await publishRealtime({
    type: 'chat.message',
    message: {
      id: message.id,
      channel: message.channel,
      authorId: message.authorId,
      authorName: message.authorName,
      body: message.body,
      mentions: message.mentions,
      replyTo: message.replyTo,
      reactions: message.reactions,
      createdAt: message.createdAt,
    },
  });
  return NextResponse.json(message, { status: 201 });
});
