import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/http';
import { getOpsQueue } from '@/lib/queue';
import { requirePermission } from '@/lib/rbac';
import { inspectUnfinishedDeployments } from '@/lib/stuck-deployments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * What the database believes in progress, confronted with the queue.
 *
 * A read, hence `deployment:read`: noting that a deployment is stuck commits to
 * nothing. It is the unblocking that decides, and it requires more.
 *
 * A dedicated route rather than a field added to `GET /api/deployments/:id`: the
 * verdict costs a read of the `ops` queue, and the deployments list is the
 * panel's most consulted screen. We pay that cost when asking the question, not
 * at each display.
 */
export const GET = apiRoute(async (request) => {
  await requirePermission(request, 'deployment:read');

  const verdicts = await inspectUnfinishedDeployments(getOpsQueue());

  return NextResponse.json({
    items: verdicts.map((verdict) => ({
      id: verdict.deployment.id,
      status: verdict.deployment.status,
      version: verdict.deployment.version,
      runtime: verdict.deployment.runtime,
      applicationId: verdict.deployment.applicationId,
      applicationSlug: verdict.deployment.applicationSlug,
      targetId: verdict.deployment.targetId,
      targetName: verdict.deployment.targetName,
      currentStep: verdict.deployment.currentStep,
      createdAt: verdict.deployment.createdAt,
      ageSeconds: Math.round(verdict.ageMs / 1000),
      ghost: verdict.ghost,
      tooRecent: verdict.tooRecent,
      job: verdict.job,
    })),
    total: verdicts.length,
    ghostCount: verdicts.filter((verdict) => verdict.ghost).length,
  });
});
