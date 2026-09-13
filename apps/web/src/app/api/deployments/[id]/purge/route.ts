import { getDeploymentSummary, logAudit, purgeDeployments } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { deployments as messages } from '@/i18n/messages/deployments';
import { ConflictError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { purgeAuditPayload } from '../../purge-audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

/**
 * Purge unitaire — efface la trace en base d'un déploiement.
 *
 * Route distincte de `DELETE /api/deployments/:id`, qui porte déjà la
 * **destruction** : celle-ci va sur la machine cible démonter l'application,
 * celle-là n'y touche pas. Les deux gestes coexistent, avec deux permissions
 * (`deployment:destroy` et `deployment:purge`) — écraser l'un par l'autre aurait
 * rendu la destruction inatteignable.
 */
export const DELETE = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'deployment:purge');
  const { id } = paramsSchema.parse(await context.params);

  const deployment = await getDeploymentSummary(id);
  if (!deployment) throw new NotFoundError(msg(messages, 'error.notFound', { id }));

  const report = await purgeDeployments({ ids: [id] });

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
