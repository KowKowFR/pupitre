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
 * At the first deployment, the screen offers to enable the automatic backup —
 * and the one that precedes each deployment. Optional: an absence changes
 * nothing to the existing policy.
 */
const createBodySchema = createDeploymentSchema.extend({
  backup: z.object({ enabled: z.boolean(), beforeDeploy: z.boolean() }).optional(),
  /**
   * The application's domains on this target — the whole list. Absent: those
   * already set stay, and a first deployment takes the AppSpec's.
   */
  domains: routeListSchema.optional(),
  /**
   * The images to deploy, service by service — what a CI passes after building and
   * pushing a tag: `{ "web": "ghcr.io/acme/web:4f2c1e9" }`. The application's
   * AppSpec is updated with it: its record says what runs, and the next deployment
   * starts again from there. Changing the application requires
   * `application:update`, on top of `deployment:create`.
   */
  images: z.record(z.string().min(1).max(48), z.string().min(1).max(512)).optional(),
});

/**
 * Replaces the requested images in the AppSpec and saves it on the application.
 * Only touches the services that deploy from an image: a service built from a
 * Dockerfile has no image to replace.
 */
async function applyImages(
  auth: AuthContext,
  application: { id: string; slug: string; appSpec: AppSpec },
  images: Record<string, string>,
  synced: boolean,
): Promise<AppSpec> {
  if (!auth.can('application:update')) throw new ForbiddenError('application:update');
  // The repository says what (rule 9): an image changed here would be erased by
  // the next commit, and the record would lie until then.
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
 * Creates the deployment and its eight steps as `pending`, then queues the job.
 *
 * The route **never waits** for the deployment: it answers 202 right away, and
 * the follow-up goes through `GET /api/deployments/:id/logs`.
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

  // Choosing the scanners and the threshold is a security decision: it has its own
  // permission. Asking for nothing requires none — it is the instance's policy that
  // applies, and it was already decided elsewhere, by someone who held
  // "settings:manage".
  const requestedScan = input.scanConfig;
  const configuresScan =
    requestedScan !== undefined &&
    (requestedScan.scanners.length > 0 || requestedScan.failOn !== 'NONE');
  if (configuresScan && !auth.can('scan:configure')) {
    throw new ForbiddenError('scan:configure');
  }

  // The instance settings apply HERE, before freezing: the configuration saved on
  // the deployment must describe what is really going to run.
  const { settings } = await getAppSettings();
  // Without an explicit request, the instance provides its policy; with a request,
  // it can only restrict it. In both cases it is decided here, before freezing: the
  // configuration saved on the deployment must describe what is really going to
  // run.
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

  // Then the application's setting, which knows what must block it. An explicit
  // request wins over it, except for what it leaves unsaid.
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

  // The preflight is authoritative: we do not deploy on a runtime the target has
  // not shown.
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

  // An application that comes from a repository: its AppSpec is a commit's, and it
  // is that commit's code that builds — wherever it is deployed.
  const synced = await getSyncedSource(input.applicationId);
  // The repository's address at its forge, copied into the deployment: the link to
  // its commit follows from it, GitHub, GitLab or Gitea.
  const syncedConnection = synced ? await getSourceConnectionById(synced.connectionId) : null;

  // The AppSpec is frozen in the deployment: the application can evolve afterwards
  // without making this deployment unreadable.
  const appSpec =
    images && Object.keys(images).length > 0
      ? await applyImages(auth, application, images, synced !== null)
      : parseAppSpec(application.appSpec);

  // Without a repository, the code of a built service comes from the last uploaded
  // archive. Refused here — nothing is queued — if it is missing, still being read,
  // was refused, or does not have the expected Dockerfile.
  const archive = synced?.syncedSha ? null : await codeFromArchive(application.id, appSpec);

  // The choice made at the first deployment: it sets the application's backup
  // policy, if there is none yet. Afterwards, it is set on its record — a
  // deployment never rewrites it.
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

  // The domains before the deployment: the pipeline reads them from its start —
  // they decide how the port is published.
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
      if (error instanceof RouteTakenError) {
        throw new ConflictError(
          msg(proxyMessages, error.application ? 'error.routeTaken' : 'error.routeTakenElsewhere', {
            hostname: error.hostname,
            application: error.application ?? '',
          }),
        );
      }
      throw error;
    }
  }

  const { deployment, steps } = await createDeploymentWithSteps({
    ...input,
    // After `...input`: it is the effective configuration that is frozen.
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
      // What the caller had asked for, when the instance set it aside: without that
      // the log would keep no trace of the intention.
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
    'deployment queued',
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
