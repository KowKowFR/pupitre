import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/http';
import { getOpsQueue } from '@/lib/queue';
import { requirePermission } from '@/lib/rbac';
import { inspectUnfinishedDeployments } from '@/lib/stuck-deployments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Ce que la base croit en cours, confronté à la file.
 *
 * Une lecture, donc `deployment:read` : constater qu'un déploiement est figé
 * n'engage rien. C'est le déblocage qui décide, et il demande davantage.
 *
 * Route dédiée plutôt qu'un champ ajouté à `GET /api/deployments/:id` : le
 * verdict coûte une lecture de la file `ops`, et la liste des déploiements est
 * l'écran le plus consulté du panel. On paie ce coût quand on pose la question,
 * pas à chaque affichage.
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
