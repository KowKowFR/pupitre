import { deleteChatMessage, getChatMessage, logAudit } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { chat as messages } from '@/i18n/messages/chat';
import { ForbiddenError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { requireTeamMember } from '@/lib/rbac';
import { publishRealtime } from '@/lib/realtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

/**
 * Deleting a message: one's own, always; someone else's, with `user:manage` — and
 * then it is traced, because it is moderation.
 */
export const DELETE = apiRoute<Context>(async (request, context) => {
  const auth = await requireTeamMember(request);
  const { id } = paramsSchema.parse(await context.params);
  const message = await getChatMessage(id);
  if (!message || message.deleted) throw new NotFoundError(msg(messages, 'error.notFound'));

  const own = message.authorId === auth.userId;
  if (!own && !auth.can('user:manage')) {
    throw new ForbiddenError('user:manage', msg(messages, 'error.forbidden'));
  }

  await deleteChatMessage(id);
  if (!own) {
    await logAudit({
      actorId: auth.userId,
      action: 'chat.message.deleted',
      resourceType: 'chat_message',
      resourceId: id,
      before: { authorId: message.authorId, createdAt: message.createdAt },
      ip: auth.ip,
    });
  }
  await publishRealtime({ type: 'chat.deleted', id, channel: message.channel });
  return new NextResponse(null, { status: 204 });
});
