import { getDeploymentSummary, logAudit, purgeDeployments } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { deployments as messages } from '@/i18n/messages/deployments';
import { currentLanguage } from '@/i18n/server';
import { ConflictError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { purgeAuditPayload } from '../../purge-audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

/**
 * A single purge — erases a deployment's trace in the database.
 *
 * A route distinct from `DELETE /api/deployments/:id`, which already carries the
 * **destruction**: that one goes onto the target machine to dismantle the
 * application, this one does not touch it. The two gestures coexist, with two
 * permissions (`deployment:destroy` and `deployment:purge`) — overwriting one
 * with the other would have made destruction unreachable.
 */
export const DELETE = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'deployment:purge');
  const { id } = paramsSchema.parse(await context.params);

  const deployment = await getDeploymentSummary(id);
  if (!deployment) throw new NotFoundError(msg(messages, 'error.notFound', { id }));

  const report = await purgeDeployments({ ids: [id] }, { language: await currentLanguage() });

  const [refusal] = report.refused;
  if (refusal) throw new ConflictError(refusal.message);

  await logAudit({
    actorId: auth.userId,
    action: 'deployment.purged',
    resourceType: 'deployment',
    resourceId: id,
    before: {
      status: deployment.status,
      version: deployment.version,
      applicationSlug: deployment.applicationSlug,
      targetName: deployment.targetName,
      url: deployment.url,
    },
    after: purgeAuditPayload(report, { ids: [id] }),
    ip: auth.ip,
  });

  return NextResponse.json({
    id,
    purged: true,
    releasedPorts: report.releasedPorts,
    rollbackTargetsLost: report.rollbackTargetsLost,
  });
});
