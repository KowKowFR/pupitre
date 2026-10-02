import { CHAT_DEFAULT_CHANNEL, CHAT_REACTIONS_MAX, isChatEmoji } from '@pupitre/core';
import { toggleChatReaction } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { chat as messages } from '@/i18n/messages/chat';
import { ConflictError, HttpError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { enforceRateLimit, type RateLimitRule } from '@/lib/rate-limit';
import { requireTeamMember } from '@/lib/rbac';
import { publishRealtime } from '@/lib/realtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

/** Plus large que l'écriture : on clique vite sur une réaction, et on se reprend. */
const CHAT_REACT_RULE: RateLimitRule = { name: 'chat:react', limit: 60, windowSec: 30 };

const bodySchema = z.object({ emoji: z.string().min(1).max(32) });

/**
 * Réagir à un message, ou retirer sa réaction : le même geste. L'état complet
 * des réactions du message part en direct — le rejouer ne change rien.
 */
export const POST = apiRoute<Context>(async (request, context) => {
  const auth = await requireTeamMember(request);
  await enforceRateLimit(CHAT_REACT_RULE, auth.userId);
  const { id } = paramsSchema.parse(await context.params);
  const { emoji } = await readJsonBody(request, bodySchema);
  if (!isChatEmoji(emoji)) throw new HttpError(422, 'not_emoji', msg(messages, 'error.notEmoji'));

  const result = await toggleChatReaction(id, auth.userId, emoji);
  if (!result.ok) {
    if (result.reason === 'not_found') throw new NotFoundError(msg(messages, 'error.notFound'));
    throw new ConflictError(msg(messages, 'error.tooManyReactions', { max: CHAT_REACTIONS_MAX }));
  }
  await publishRealtime({
    type: 'chat.reactions',
    messageId: id,
    channel: CHAT_DEFAULT_CHANNEL,
    reactions: result.reactions,
  });
  return NextResponse.json({ reactions: result.reactions });
});
