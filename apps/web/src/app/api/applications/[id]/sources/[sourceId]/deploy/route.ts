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
 * "Deploy the last commit": a human decision, which counts as approval. The
 * worker reads the branch's head, validates its pupitre.json and deploys on the
 * link's targets, whatever the mode.
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
