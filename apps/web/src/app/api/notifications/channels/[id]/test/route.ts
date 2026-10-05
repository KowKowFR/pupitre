import { getNotificationChannel, logAudit } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { notifications } from '@/i18n/messages/notifications';
import { NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { runChannelTest } from '@/lib/notifications';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

/**
 * Sends a test message and **waits for the verdict**.
 *
 * This button is not an ornament: a wrong SMTP configuration is otherwise only
 * discovered at the first incident, that is at the worst moment. A "it is queued"
 * answer would say nothing about what one wants to know.
 *
 * The synchronous / queue trade-off is detailed in `@/lib/notifications`: the
 * route queues then waits, on the model of `/api/targets/[id]/metrics`, because
 * the panel has no SMTP transport and the real work belongs to the worker.
 *
 * `settings:manage` and not `settings:read`: a test makes a message *go out* to a
 * third party, with the instance's credentials. It is a write to the outside, not
 * a read.
 */
export const POST = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'settings:manage');
  const { id } = paramsSchema.parse(await context.params);

  const channel = await getNotificationChannel(id);
  if (!channel) throw new NotFoundError(msg(notifications, 'error.channelNotFound', { id }));

  const result = await runChannelTest(id, auth.userId, auth.ip);

  await logAudit({
    actorId: auth.userId,
    action: 'notification.channel.tested',
    resourceType: 'notification_channel',
    resourceId: id,
    after: {
      kind: result.kind,
      name: channel.name,
      probeOk: result.probe.ok,
      delivered: result.delivered,
      // Already redacted by the sending layer: no token fragment here.
      error: result.error,
    },
    ip: auth.ip,
  });

  return NextResponse.json({ ...result, name: channel.name });
});
