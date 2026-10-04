import {
  DEPLOYMENT_RUN_JOB,
  SOURCE_ARCHIVES_KEPT,
  applySecuritySettings,
  deploymentJobDataSchema,
  parseAppSpec,
  usableRuntimes,
  withApplicationScanPolicy,
} from '@pupitre/core';
import {
  applicationScanPolicyOf,
  createDeploymentWithSteps,
  getAppSettings,
  getApplication,
  getDeploymentForRun,
  getSourceArchive,
  getTarget,
  logAudit,
} from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { applications as messages } from '@/i18n/messages/applications';
import { archives as archiveMessages } from '@/i18n/messages/archives';
import { ConflictError, ForbiddenError, HttpError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { logger } from '@/lib/logger';
import { getOpsQueue } from '@/lib/queue';
import { requireApplicationScope, requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  /** The deployment whose AppSpec is replayed — it is the "version". */
  versionId: z.string().uuid(),
  targetId: z.string().uuid(),
  autoRollback: z.boolean().default(true),
});

/**
 * Redeploys a known earlier version.
 *
 * It is **not** a rollback: the rollback puts back in service a release already
 * present on the target, here we redo a complete deployment — new version number,
 * new pipeline, new scans — from the AppSpec frozen at the time. That is what
 * allows replaying a version on *another* target, or after a `destroy`.
 */
export const POST = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'deployment:create', { applicationScoped: true });
  const { id } = paramsSchema.parse(await context.params);
  await requireApplicationScope(request, auth, id);
  const input = await readJsonBody(request, bodySchema);

  const application = await getApplication(id);
  if (!application) throw new NotFoundError(msg(messages, 'error.notFound', { id }));

  const source = await getDeploymentForRun(input.versionId);
  if (!source) {
    throw new NotFoundError(msg(messages, 'error.versionNotFound', { id: input.versionId }));
  }
  if (source.deployment.applicationId !== id) {
    throw new ConflictError(msg(messages, 'error.versionOtherApplication'));
  }
  if (!source.deployment.appSpec) {
    throw new ConflictError(
      msg(messages, 'error.versionNoSpec', { version: source.deployment.version }),
    );
  }

  const target = await getTarget(input.targetId);
  if (!target) {
    throw new NotFoundError(msg(messages, 'error.targetNotFound', { id: input.targetId }));
  }

  const available = usableRuntimes(target.runtimesAvailable);
  if (!available.includes(source.deployment.runtime)) {
    throw new ConflictError(
      msg(
        messages,
        available.length === 0
          ? 'error.versionRuntimeUnavailable.none'
          : 'error.versionRuntimeUnavailable',
        {
          runtime: source.deployment.runtime,
          target: target.name,
          available: available.join(', '),
        },
      ),
    );
  }

  // The scan policy is replayed as is: redeploying a version is not the occasion
  // to lower one's guard without saying so. It therefore stays subject to the same
  // permission as at creation.
  const requestedScan = source.deployment.scanConfig ?? { scanners: [], failOn: 'NONE' as const };
  const configuresScan = requestedScan.scanners.length > 0 || requestedScan.failOn !== 'NONE';
  if (configuresScan && !auth.can('scan:configure')) {
    throw new ForbiddenError('scan:configure');
  }

  // The instance settings take precedence over the inherited policy: a disabled
  // analysis must not come back through the door of a redeployment. The
  // application's setting, on the other hand, applies: it is the application that
  // decides what blocks it, not the version — and setting it requires
  // `scan:configure`.
  const { settings } = await getAppSettings();
  const scanConfig = withApplicationScanPolicy(
    applySecuritySettings(requestedScan, settings.security),
    applicationScanPolicyOf(application),
  );

  const appSpec = parseAppSpec(source.deployment.appSpec);

  // A version built from an uploaded archive needs it: only the last ones are
  // kept, and nothing else would replace it.
  const archive = source.deployment.sourceArchiveSha256
    ? {
        id: source.deployment.sourceArchiveId,
        name: source.deployment.sourceArchiveName ?? 'archive',
        sha256: source.deployment.sourceArchiveSha256,
      }
    : null;
  if (archive) {
    const stored = archive.id ? await getSourceArchive(archive.id) : null;
    if (!stored || stored.status !== 'ready' || stored.sha256 !== archive.sha256) {
      throw new HttpError(
        409,
        'archive_gone',
        msg(archiveMessages, 'redeploy.gone', { name: archive.name, count: SOURCE_ARCHIVES_KEPT }),
      );
    }
  }

  const { deployment, steps } = await createDeploymentWithSteps({
    applicationId: id,
    targetId: input.targetId,
    runtime: source.deployment.runtime,
    scanConfig,
    autoRollback: input.autoRollback,
    appSpec,
    triggeredBy: auth.userId,
    // The commit follows the AppSpec: a service that builds needs the exact code of
    // the replayed version, not the branch's current head.
    ...(source.deployment.sourceRepository && source.deployment.sourceSha
      ? {
          source: {
            sourceId: source.deployment.sourceId,
            repository: source.deployment.sourceRepository,
            ref: source.deployment.sourceRef,
            sha: source.deployment.sourceSha,
            url: source.deployment.sourceUrl,
          },
        }
      : {}),
    ...(archive ? { archive } : {}),
  });

  const job = await getOpsQueue().add(
    DEPLOYMENT_RUN_JOB,
    deploymentJobDataSchema.parse({
      deploymentId: deployment.id,
      actorId: auth.userId,
      ip: auth.ip,
    }),
    { attempts: 1 },
  );
  if (!job.id) throw new HttpError(500, 'enqueue_failed', msg(messages, 'error.enqueueFailed'));

  await logAudit({
    actorId: auth.userId,
    action: 'deployment.redeployed',
    resourceType: 'deployment',
    resourceId: deployment.id,
    before: {
      sourceDeploymentId: source.deployment.id,
      sourceSequence: source.deployment.version,
      sourceVersion: appSpec.version,
    },
    after: {
      applicationSlug: application.slug,
      targetName: target.name,
      runtime: source.deployment.runtime,
      number: deployment.number,
      version: deployment.version,
      autoRollback: deployment.autoRollback,
      jobId: job.id,
    },
    ip: auth.ip,
  });

  logger.info(
    { deploymentId: deployment.id, from: source.deployment.id, jobId: job.id },
    'redeployment queued',
  );

  return NextResponse.json(
    {
      id: deployment.id,
      number: deployment.number,
      status: deployment.status,
      version: deployment.version,
      appVersion: appSpec.version,
      from: source.deployment.id,
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
