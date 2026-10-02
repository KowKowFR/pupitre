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
   * `accept` : la machine a été réinstallée, sa nouvelle clé devient la clé
   * retenue. `dismiss` : on garde l'ancienne — les connexions restent refusées
   * tant que la machine présente l'autre.
   */
  decision: z.enum(['accept', 'dismiss']),
});

/**
 * Trancher une clé d'hôte inattendue. Le worker l'a notée en refusant la
 * connexion ; seul un humain sait si la machine a été réinstallée ou si une
 * autre se fait passer pour elle. La décision est tracée, avec les deux
 * empreintes.
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
