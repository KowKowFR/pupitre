import { getTarget, logAudit, resolveTargetHostKey } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { targets as messages } from '@/i18n/messages/targets';
import { ConflictError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  /**
   * `accept`: the machine was reinstalled, its new key becomes the kept key.
   * `dismiss`: we keep the old one — the connections stay refused as long as the
   * machine presents the other.
   */
  decision: z.enum(['accept', 'dismiss']),
});

/**
 * Deciding on an unexpected host key. The worker noted it while refusing the
 * connection; only a human knows whether the machine was reinstalled or another
 * one is impersonating it. The decision is traced, with both fingerprints.
 */
export const POST = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'target:update');
  const { id } = paramsSchema.parse(await context.params);
  const target = await getTarget(id);
  if (!target) throw new NotFoundError(msg(messages, 'error.notFound', { id }));
  const { decision } = await readJsonBody(request, bodySchema);

  const resolved = await resolveTargetHostKey(id, decision);
  if (!resolved) throw new ConflictError(msg(messages, 'error.noPendingHostKey'));

  await logAudit({
    actorId: auth.userId,
    action: decision === 'accept' ? 'target.host_key.accepted' : 'target.host_key.dismissed',
    resourceType: 'target',
    resourceId: id,
    before: { fingerprint: resolved.previous },
    after: {
      name: target.name,
      host: target.host,
      ...(decision === 'accept'
        ? { fingerprint: resolved.pending }
        : { dismissed: resolved.pending }),
    },
    ip: auth.ip,
  });
  return NextResponse.json({ target: await getTarget(id) });
});
