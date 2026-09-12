import { PURGE_MAX_ROWS, logAudit, purgeDeployments, purgeFilterSchema } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiRoute, readJsonBody } from '@/lib/http';
import { logger } from '@/lib/logger';
import { requirePermission } from '@/lib/rbac';
import { purgeAuditPayload } from '../purge-audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Purge en masse de l'historique.
 *
 * Purger n'est pas détruire : rien n'est touché sur la machine cible, seule la
 * trace en base disparaît. Le garde-fou — un déploiement en service ne se purge
 * pas — vit dans `purgeDeployments()`, pas ici.
 *
 * Une seule route pour la prévisualisation et l'exécution, distinguées par
 * `dryRun`. Un `GET` avec les mêmes filtres aurait obligé à encoder un tableau
 * d'identifiants en query string, et surtout à maintenir deux chemins de
 * décision là où l'écran a besoin de la garantie inverse : le décompte annoncé
 * dans la confirmation est *exactement* celui qui sera appliqué.
 */
const purgeRequestSchema = z.intersection(
  purgeFilterSchema,
  z.object({ dryRun: z.boolean().default(false) }),
);

export const POST = apiRoute(async (request) => {
  const auth = await requirePermission(request, 'deployment:purge');
  const { dryRun, ...filter } = await readJsonBody(request, purgeRequestSchema);

  const report = await purgeDeployments(filter, { dryRun });

  // Une prévisualisation n'a rien changé : elle n'a rien à journaliser.
  if (!dryRun && report.purgedCount > 0) {
    await logAudit({
      actorId: auth.userId,
      action: 'deployment.purged',
      resourceType: 'deployment',
      resourceId: null,
      after: purgeAuditPayload(report, filter),
      ip: auth.ip,
    });

    logger.info(
      { purged: report.purgedCount, refused: report.refusedCount, actorId: auth.userId },
      'historique de déploiements purgé',
    );
  }

  // Le plafond fait partie du contrat : un client qui voit `truncated` sait
  // qu'il lui reste des lignes et qu'il doit rappeler la route.
  return NextResponse.json({ ...report, limit: PURGE_MAX_ROWS });
});
