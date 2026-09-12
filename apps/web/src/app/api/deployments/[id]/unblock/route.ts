import { abandonDeployment, getDeploymentSummary, logAudit } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ConflictError, HttpError, NotFoundError } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { logger } from '@/lib/logger';
import { getOpsQueue } from '@/lib/queue';
import { requirePermission } from '@/lib/rbac';
import { inspectDeployment, refusalMessage } from '@/lib/stuck-deployments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

/**
 * Débloque un déploiement figé : le statut « en cours » devient « échoué ».
 *
 * ── Pourquoi `deployment:purge` ──────────────────────────────────────────────
 * Le geste ne touche pas la machine — il corrige un enregistrement que le panel
 * a laissé mentir. C'est exactement le partage que pose le vocabulaire RBAC :
 * « Détruire retire l'application de la machine ; purger efface la trace en
 * base. Deux gestes différents, deux permissions. » Débloquer est du côté de la
 * base. Et c'est littéralement l'acte qui lève un refus de purge : la purge
 * refuse un déploiement `in_progress`, et rien d'autre ne pouvait le sortir de
 * cet état. Exiger `deployment:destroy` aurait laissé croire qu'on va démonter
 * quelque chose ; on ne démonte rien, on cesse de mentir.
 *
 * ── Pourquoi aucune reprise ──────────────────────────────────────────────────
 * Rien n'est réenfilé. Rejouer un pipeline dont on ignore où il s'est arrêté
 * redéploierait par-dessus un état inconnu. Le déploiement est arrêté sur un
 * échec qui **nomme ce qui reste à vérifier sur la cible** ; c'est ensuite la
 * destruction — un geste explicite, avec sa propre permission — qui remet la
 * machine à plat.
 */
export const POST = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'deployment:purge');
  const { id } = paramsSchema.parse(await context.params);

  const summary = await getDeploymentSummary(id);
  if (!summary) throw new NotFoundError(`Déploiement « ${id} » introuvable`);

  if (summary.status !== 'pending' && summary.status !== 'running') {
    throw new ConflictError(
      `Ce déploiement est déjà conclu (« ${summary.status} ») : il n'y a rien à débloquer.`,
    );
  }

  const verdict = await inspectDeployment(getOpsQueue(), id);
  // Conclu entre les deux lectures : le worker a rendu son verdict tout seul.
  if (!verdict) {
    throw new ConflictError(
      "Ce déploiement s'est conclu pendant la vérification : rien à débloquer.",
    );
  }

  if (!verdict.ghost) {
    throw new HttpError(409, 'deployment_not_stuck', refusalMessage(verdict), {
      job: verdict.job,
      ageSeconds: Math.round(verdict.ageMs / 1000),
    });
  }

  const report = await abandonDeployment(id, {
    cause: 'file interrogée à la demande depuis le panel',
  });
  if (!report) {
    throw new ConflictError(
      "Ce déploiement s'est conclu pendant le déblocage : son statut n'a pas été touché.",
    );
  }

  await logAudit({
    actorId: auth.userId,
    action: 'deployment.unblocked',
    resourceType: 'deployment',
    resourceId: id,
    before: { status: summary.status, failedStep: summary.failedStep },
    after: {
      status: 'failed',
      failedStep: report.failedStep,
      mayHaveStartedServices: report.mayHaveStartedServices,
      applicationSlug: report.applicationSlug,
      targetName: report.targetName,
      error: report.error,
      detectedBy: 'aucune tâche exécutable dans la file « ops »',
    },
    ip: auth.ip,
  });

  logger.warn(
    { deploymentId: id, failedStep: report.failedStep },
    'déploiement figé débloqué à la main',
  );

  return NextResponse.json({
    id,
    status: 'failed' as const,
    failedStep: report.failedStep,
    mayHaveStartedServices: report.mayHaveStartedServices,
    error: report.error,
  });
});
