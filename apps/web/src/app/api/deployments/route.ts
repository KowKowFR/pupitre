import {
  DEPLOYMENT_RUN_JOB,
  applySecuritySettings,
  deploymentJobDataSchema,
  scanConfigFromSettings,
  parseAppSpec,
  parseImageReference,
  type AppSpec,
  proxyCapabilities,
  routeListSchema,
  usableRuntimes,
  withApplicationScanPolicy,
} from '@pupitre/core';
import {
  applicationScanPolicyOf,
  createDeploymentSchema,
  createDeploymentWithSteps,
  deploymentQuerySchema,
  getApplication,
  getAppSettings,
  getBackupPolicy,
  getSourceConnectionById,
  getSyncedSource,
  sourceRepositoryUrl,
  getTarget,
  listDeployments,
  logAudit,
  replaceRoutes,
  updateApplication,
  resolveServingProxy,
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
import { requireApplicationScope, requirePermission, type AuthContext } from '@/lib/rbac';
import { codeFromArchive } from '@/lib/source-archives';

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
  /**
   * Les images à déployer, service par service — ce qu'une CI passe après avoir
   * construit et poussé un tag : `{ "web": "ghcr.io/acme/web:4f2c1e9" }`.
   * L'AppSpec de l'application est mise à jour avec : sa fiche dit ce qui
   * tourne, et le déploiement suivant repart de là. Changer l'application
   * demande `application:update`, en plus de `deployment:create`.
   */
  images: z.record(z.string().min(1).max(48), z.string().min(1).max(512)).optional(),
});

/**
 * Remplace les images demandées dans l'AppSpec et l'enregistre sur
 * l'application. Ne touche qu'aux services qui se déploient depuis une image :
 * un service construit depuis un Dockerfile n'a pas d'image à remplacer.
 */
async function applyImages(
  auth: AuthContext,
  application: { id: string; slug: string; appSpec: AppSpec },
  images: Record<string, string>,
  synced: boolean,
): Promise<AppSpec> {
  if (!auth.can('application:update')) throw new ForbiddenError('application:update');
  // Le dépôt dit quoi (règle n° 9) : une image changée ici serait effacée par
  // le prochain commit, et la fiche mentirait d'ici là.
  if (synced) {
    throw new ConflictError(
      msg(messages, 'error.images.synced', { application: application.slug }),
    );
  }
  const spec = parseAppSpec(application.appSpec);
  const changed: Record<string, { before: string; after: string }> = {};
  for (const [service, ref] of Object.entries(images)) {
    const found = spec.services.find((candidate) => candidate.name === service);
    if (!found) {
      throw new HttpError(
        422,
        'unknown_service',
        msg(messages, 'error.images.unknownService', { service, application: application.slug }),
      );
    }
    if (found.source.type !== 'image') {
      throw new HttpError(422, 'not_an_image', msg(messages, 'error.images.notImage', { service }));
    }
    if (!parseImageReference(ref)) {
      throw new HttpError(422, 'invalid_image', msg(messages, 'error.images.invalid', { ref }));
    }
    if (found.source.ref !== ref) changed[service] = { before: found.source.ref, after: ref };
  }
  if (Object.keys(changed).length === 0) return spec;

  const next = parseAppSpec({
    ...spec,
    services: spec.services.map((service) =>
      changed[service.name]
        ? { ...service, source: { type: 'image', ref: changed[service.name]!.after } }
        : service,
    ),
  });
  await updateApplication(application.id, { appSpec: next });
  await logAudit({
    actorId: auth.userId,
    action: 'application.updated',
    resourceType: 'application',
    resourceId: application.id,
    before: { images: Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v.before])) },
    after: {
      images: Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v.after])),
      origin: 'deployment',
    },
    ip: auth.ip,
  });
  return next;
}

/**
 * Crée le déploiement et ses huit étapes en `pending`, puis enfile le job.
 *
 * La route **n'attend jamais** le déploiement : elle répond 202 tout de suite,
 * et le suivi se fait par `GET /api/deployments/:id/logs`.
 */
export const POST = apiRoute(async (request) => {
  const auth = await requirePermission(request, 'deployment:create', { applicationScoped: true });
  const {
    backup: backupChoice,
    domains,
    images,
    ...input
  } = await readJsonBody(request, createBodySchema);
  await requireApplicationScope(request, auth, input.applicationId);

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

  // Puis le réglage de l'application, qui sait ce qui doit la bloquer. Une
  // demande explicite l'emporte sur lui, sauf pour ce qu'elle tait.
  const applicationPolicy = applicationScanPolicyOf(application);
  const scanConfig =
    requestedScan === undefined
      ? withApplicationScanPolicy(scanConfigFromSettings(settings.security), applicationPolicy)
      : applySecuritySettings(
          {
            ...requestedScan,
            onlyFixable: requestedScan.onlyFixable ?? applicationPolicy.onlyFixable ?? undefined,
          },
          settings.security,
        );

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

  // Une application qui vient d'un dépôt : son AppSpec est celle d'un commit,
  // et c'est le code de ce commit qui se construit — où qu'on la déploie.
  const synced = await getSyncedSource(input.applicationId);
  // L'adresse du dépôt chez sa forge, recopiée dans le déploiement : le lien
  // vers son commit en découle, GitHub, GitLab ou Gitea.
  const syncedConnection = synced ? await getSourceConnectionById(synced.connectionId) : null;

  // L'AppSpec est figée dans le déploiement : l'application peut évoluer
  // ensuite sans rendre ce déploiement illisible.
  const appSpec =
    images && Object.keys(images).length > 0
      ? await applyImages(auth, application, images, synced !== null)
      : parseAppSpec(application.appSpec);

  // Sans dépôt, le code d'un service construit vient de la dernière archive
  // téléversée. Refusé ici — rien n'est enfilé — si elle manque, est encore
  // en lecture, a été refusée, ou n'a pas le Dockerfile qu'on attend.
  const archive = synced?.syncedSha ? null : await codeFromArchive(application.id, appSpec);

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
    const proxy = (await resolveServingProxy(input.targetId))?.proxy ?? null;
    if (!proxy && domains.length > 0) {
      throw new ConflictError(msg(proxyMessages, 'error.noProxy', { target: target.name }));
    }
    if (proxy?.status === 'installing' && domains.length > 0) {
      throw new ConflictError(msg(proxyMessages, 'error.installing'));
    }
    if (proxy && proxy.status !== 'installing') {
      assertServable(domains, proxyCapabilities(proxy.kind, proxy.config));
    }
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
    ...(synced?.syncedSha
      ? {
          source: {
            sourceId: synced.id,
            repository: synced.repository,
            ref: synced.branch,
            sha: synced.syncedSha,
            url: syncedConnection ? sourceRepositoryUrl(syncedConnection, synced.repository) : null,
          },
        }
      : {}),
    ...(archive ? { archive } : {}),
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
