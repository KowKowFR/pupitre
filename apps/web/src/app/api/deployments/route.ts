import {
  DEPLOYMENT_RUN_JOB,
  applySecuritySettings,
  deploymentJobDataSchema,
  scanConfigFromSettings,
  parseAppSpec,
  proxyCapabilities,
  routeListSchema,
  usableRuntimes,
} from '@pupitre/core';
import {
  createDeploymentSchema,
  createDeploymentWithSteps,
  deploymentQuerySchema,
  getAppSettings,
  getApplication,
  getBackupPolicy,
  getProxyForTarget,
  getTarget,
  listDeployments,
  logAudit,
  replaceRoutes,
  RouteTakenError,
  saveBackupPolicy,
} from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ensureBackupSchedule } from '@/lib/backups';
import { deployments as messages } from '@/i18n/messages/deployments';
import { proxy as proxyMessages } from '@/i18n/messages/proxy';
import { ConflictError, ForbiddenError, HttpError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody, readSearchParams } from '@/lib/http';
import { logger } from '@/lib/logger';
import { assertServable } from '@/lib/proxy';
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
 * Au premier déploiement, l'écran propose d'activer la sauvegarde
 * automatique — et celle qui précède chaque déploiement. Facultatif : une
 * absence ne change rien à la politique existante.
 */
const createBodySchema = createDeploymentSchema.extend({
  backup: z.object({ enabled: z.boolean(), beforeDeploy: z.boolean() }).optional(),
  /**
   * Les domaines de l'application sur cette cible — la liste entière. Absent :
   * ceux déjà posés restent, et un premier déploiement reprend celui de
   * l'AppSpec.
   */
  domains: routeListSchema.optional(),
});

/**
 * Crée le déploiement et ses huit étapes en `pending`, puis enfile le job.
 *
 * La route **n'attend jamais** le déploiement : elle répond 202 tout de suite,
 * et le suivi se fait par `GET /api/deployments/:id/logs`.
 */
export const POST = apiRoute(async (request) => {
  const auth = await requirePermission(request, 'deployment:create');
  const { backup: backupChoice, domains, ...input } = await readJsonBody(request, createBodySchema);

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

  // Le preflight fait foi : on ne déploie pas sur un runtime que la
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

  // Le choix fait au premier déploiement : il pose la politique de sauvegarde
  // de l'application, s'il n'y en a pas encore. Ensuite, elle se règle sur sa
  // fiche — un déploiement ne la réécrit jamais.
  if (backupChoice && auth.can('backup:manage')) {
    const current = await getBackupPolicy(application.id);
    if (!current.configured) {
      await saveBackupPolicy(
        application.id,
        { ...current, enabled: backupChoice.enabled, beforeDeploy: backupChoice.beforeDeploy },
        auth.userId,
      );
      if (backupChoice.enabled) await ensureBackupSchedule('backup');
      await logAudit({
        actorId: auth.userId,
        action: 'backup.policy.updated',
        resourceType: 'application',
        resourceId: application.id,
        after: {
          application: application.slug,
          enabled: backupChoice.enabled,
          beforeDeploy: backupChoice.beforeDeploy,
          origin: 'first_deployment',
        },
        ip: auth.ip,
      });
    }
  }

  // Les domaines avant le déploiement : le pipeline les lit dès son départ —
  // ils décident de la publication du port.
  if (domains) {
    const proxy = await getProxyForTarget(input.targetId);
    if (!proxy && domains.length > 0) {
      throw new ConflictError(msg(proxyMessages, 'error.noProxy', { target: target.name }));
    }
    if (proxy) assertServable(domains, proxyCapabilities(proxy.kind, proxy.config));
    try {
      await replaceRoutes(
        application.id,
        input.targetId,
        domains.map((route) => ({ ...route, redirectHttps: route.tls && route.redirectHttps })),
      );
    } catch (error) {
      if (error instanceof RouteTakenError) throw new ConflictError(error.message);
      throw error;
    }
  }

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
      number: deployment.number,
      version: deployment.version,
      scanners: scanConfig.scanners,
      failOn: scanConfig.failOn,
      // Ce que l'appelant avait demandé, quand l'instance l'a écarté : sans
      // cela le journal ne garderait aucune trace de l'intention.
      ...(scanConfig.disabledBy
        ? {
            scanRequested: requestedScan?.scanners ?? "(politique de l'instance)",
            scanDisabledBy: scanConfig.disabledBy,
          }
        : {}),
      autoRollback: input.autoRollback,
      ...(domains ? { domains: domains.map((route) => route.hostname) } : {}),
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
      number: deployment.number,
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
