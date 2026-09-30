import { logAudit } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiRoute } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { enqueueSourceDeploy, sourceOf } from '@/lib/source-routes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid(), sourceId: z.string().uuid() });
type Context = { params: Promise<{ id: string; sourceId: string }> };

/**
 * « Déployer le dernier commit » : une décision humaine, qui vaut validation.
 * Le worker lit la tête de la branche, valide son pupitre.json et déploie sur
 * les cibles de la liaison, quel que soit le mode.
 */
export const POST = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'deployment:create');
  const { id, sourceId } = paramsSchema.parse(await context.params);
  const source = await sourceOf(id, sourceId);
  const jobId = await enqueueSourceDeploy({
    kind: 'head',
    sourceId,
    actorId: auth.userId,
    ip: auth.ip,
  });
  await logAudit({
    actorId: auth.userId,
    action: 'source.deploy.requested',
    resourceType: 'application_source',
    resourceId: sourceId,
    after: { repository: source.repository, branch: source.branch, jobId },
    ip: auth.ip,
  });
  return NextResponse.json({ jobId }, { status: 202 });
});
