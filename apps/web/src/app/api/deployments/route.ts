import {
  DEPLOYMENT_RUN_JOB,
  applySecuritySettings,
  deploymentJobDataSchema,
  scanConfigFromSettings,
  parseAppSpec,
  usableRuntimes,
} from '@pupitre/core';
import {
  createDeploymentSchema,
  createDeploymentWithSteps,
  deploymentQuerySchema,
  getAppSettings,
  getApplication,
  getTarget,
  listDeployments,
  logAudit,
} from '@pupitre/db';
import { NextResponse } from 'next/server';
import { deployments as messages } from '@/i18n/messages/deployments';
import { ConflictError, ForbiddenError, HttpError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody, readSearchParams } from '@/lib/http';
import { logger } from '@/lib/logger';
import { getOpsQueue } from '@/lib/queue';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = apiRoute(async (request) => {
  await requirePermission(request, 'deployment:read');
  const query = readSearchParams(request, deploymentQuerySchema);
  return NextResponse.json(await listDeployments(query));
});

/**
 * Crée le déploiement et ses huit étapes en `pending`, puis enfile le job.
 *
 * La route **n'attend jamais** le déploiement : elle répond 202 tout de suite,
 * et le suivi se fait par `GET /api/deployments/:id/logs`.
 */
export const POST = apiRoute(async (request) => {
  const auth = await requirePermission(request, 'deployment:create');
  const input = await readJsonBody(request, createDeploymentSchema);

  // Choisir les scanners et le seuil est une décision de sécurité : elle a sa
  // propre permission. Ne rien demander n'en réclame aucune — c'est la
  // politique de l'instance qui s'applique, et elle a déjà été décidée
  // ailleurs, par quelqu'un qui portait « settings:manage ».
  const requestedScan = input.scanConfig;
  const configuresScan =
    requestedScan !== undefined &&
    (requestedScan.scanners.length > 0 || requestedScan.failOn !== 'NONE');
  if (configuresScan && !auth.can('scan:configure')) {
    throw new ForbiddenError('scan:configure');
  }

  // Les réglages d'instance s'appliquent ICI, avant le gel : la configuration
  // enregistrée sur le déploiement doit décrire ce qui va réellement tourner.
  const { settings } = await getAppSettings();
  // Sans demande explicite, l'instance fournit sa politique ; avec une demande,
  // elle ne peut que la restreindre. Dans les deux cas c'est ici que ça se
  // joue, avant le gel : la configuration enregistrée sur le déploiement doit
  // décrire ce qui va réellement tourner.
  const scanConfig =
    requestedScan === undefined
      ? scanConfigFromSettings(settings.security)
      : applySecuritySettings(requestedScan, settings.security);

  const [application, target] = await Promise.all([
    getApplication(input.applicationId),
    getTarget(input.targetId),
  ]);

  if (!application) {
    throw new NotFoundError(msg(messages, 'error.applicationNotFound', { id: input.applicationId }));
  }
  if (!target) {
    throw new NotFoundError(msg(messages, 'error.targetNotFound', { id: input.targetId }));
  }

  // Le preflight du jalon 3 fait foi : on ne déploie pas sur un runtime que la
  // cible n'a pas montré.
  const available = usableRuntimes(target.runtimesAvailable);
  if (!available.includes(input.runtime)) {
    throw new ConflictError(
      target.lastPreflightAt === null
        ? msg(messages, 'error.neverPreflighted', { target: target.name })
        : msg(
            messages,
            available.length === 0
              ? 'error.runtimeUnavailable.none'
              : 'error.runtimeUnavailable',
            { runtime: input.runtime, target: target.name, available: available.join(', ') },
          ),
    );
  }

  // L'AppSpec est figée dans le déploiement : l'application peut évoluer
  // ensuite sans rendre ce déploiement illisible.
  const appSpec = parseAppSpec(application.appSpec);

  const { deployment, steps } = await createDeploymentWithSteps({
    ...input,
    // Après `...input` : c'est la configuration effective qui est gelée.
    scanConfig,
    appSpec,
    triggeredBy: auth.userId,
  });

  const jobData = deploymentJobDataSchema.parse({
    deploymentId: deployment.id,
    actorId: auth.userId,
    ip: auth.ip,
  });

  const job = await getOpsQueue().add(DEPLOYMENT_RUN_JOB, jobData, { attempts: 1 });
  if (!job.id) {
    throw new HttpError(500, 'enqueue_failed', msg(messages, 'error.enqueueFailed'));
  }

  await logAudit({
    actorId: auth.userId,
    action: 'deployment.created',
    resourceType: 'deployment',
    resourceId: deployment.id,
    after: {
      applicationSlug: application.slug,
      targetName: target.name,
      runtime: input.runtime,
      proxy: input.proxy,
      version: deployment.version,
      scanners: scanConfig.scanners,
      failOn: scanConfig.failOn,
      // Ce que l'appelant avait demandé, quand l'instance l'a écarté : sans
      // cela le journal ne garderait aucune trace de l'intention.
      ...(scanConfig.disabledBy
        ? {
            scanRequested: requestedScan?.scanners ?? '(politique de l\'instance)',
            scanDisabledBy: scanConfig.disabledBy,
          }
        : {}),
      autoRollback: input.autoRollback,
      jobId: job.id,
    },
    ip: auth.ip,
  });

  logger.info(
    { deploymentId: deployment.id, jobId: job.id, runtime: input.runtime },
    'déploiement enfilé',
  );

  return NextResponse.json(
    {
      id: deployment.id,
      status: deployment.status,
      version: deployment.version,
      scanConfig,
      autoRollback: deployment.autoRollback,
      jobId: job.id,
      steps: steps.map((step) => ({
        key: step.key,
        label: step.label,
        status: step.status,
        order: step.order,
      })),
    },
    { status: 202 },
  );
});
