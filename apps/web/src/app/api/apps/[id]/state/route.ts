import { isSupervisable, workspaceNameFor } from '@pupitre/core';
import { getDeploymentSummary } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

/**
 * Ce qu'il faut savoir pour proposer — ou refuser — les gestes d'exploitation
 * d'une application : est-elle arrêtée, depuis quand, y a-t-il une version
 * précédente, quel port et quel regroupement une destruction emporterait.
 *
 * ── Pourquoi une route, alors que la page pourrait tout passer en props ─────
 * Parce que les gestes changent l'état qu'ils affichent. Après un arrêt, le
 * bouton doit devenir « Démarrer » sans recharger la page, et après un
 * démarrage l'inverse. Une prop rendue côté serveur ne bouge que sur
 * `router.refresh()`, qui rejoue toute la page — y compris la console de logs
 * et sa reconnexion SSE. Une lecture de quelques champs vaut mieux.
 *
 * Elle ne touche **pas** à la machine : tout vient de la base. Ouvrir une
 * session SSH dans une route HTTP est précisément ce que le projet interdit, et
 * l'état réel des conteneurs arrive déjà par le flux de supervision.
 *
 * `deployment:read` suffit : elle ne dit rien de plus que la page elle-même.
 */
export const GET = apiRoute<Context>(async (request, context) => {
  await requirePermission(request, 'deployment:read');
  const { id } = paramsSchema.parse(await context.params);

  const deployment = await getDeploymentSummary(id);
  if (!deployment) throw new NotFoundError(`Déploiement « ${id} » introuvable`);

  // La version vers laquelle un rollback ramène, nommée : « revenir à la v2 »
  // se comprend, « revenir en arrière » se subit.
  const previous = deployment.previousDeploymentId
    ? await getDeploymentSummary(deployment.previousDeploymentId)
    : null;

  return NextResponse.json({
    id: deployment.id,
    status: deployment.status,
    supervisable: isSupervisable(deployment.status),
    stoppedAt: deployment.stoppedAt?.toISOString() ?? null,
    version: deployment.version,
    url: deployment.url,
    publishedPort: deployment.publishedPort,
    applicationId: deployment.applicationId,
    applicationSlug: deployment.applicationSlug,
    targetId: deployment.targetId,
    targetName: deployment.targetName,
    runtime: deployment.runtime,
    workspace: workspaceNameFor(deployment.applicationSlug),
    previous: previous ? { id: previous.id, version: previous.version } : null,
  });
});
