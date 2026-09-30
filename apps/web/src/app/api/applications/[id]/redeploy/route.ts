import {
  DEPLOYMENT_RUN_JOB,
  applySecuritySettings,
  deploymentJobDataSchema,
  parseAppSpec,
  usableRuntimes,
} from '@pupitre/core';
import {
  createDeploymentWithSteps,
  getAppSettings,
  getApplication,
  getDeploymentForRun,
  getTarget,
  logAudit,
} from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { applications as messages } from '@/i18n/messages/applications';
import { ConflictError, ForbiddenError, HttpError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { logger } from '@/lib/logger';
import { getOpsQueue } from '@/lib/queue';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  /** Déploiement dont on rejoue l'AppSpec — c'est lui, la « version ». */
  versionId: z.string().uuid(),
  targetId: z.string().uuid(),
  autoRollback: z.boolean().default(true),
});

/**
 * Redéploie une version antérieure connue.
 *
 * Ce n'est **pas** un rollback : le rollback remet en service une release déjà
 * présente sur la cible, ici on refait un déploiement complet — nouveau numéro
 * de version, nouveau pipeline, nouveaux scans — à partir de l'AppSpec figée à
 * l'époque. C'est ce qui permet de rejouer une version sur une *autre* cible,
 * ou après un `destroy`.
 */
export const POST = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'deployment:create');
  const { id } = paramsSchema.parse(await context.params);
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

  // La politique de scan est rejouée telle quelle : redéployer une version, ce
  // n'est pas l'occasion de baisser la garde sans le dire. Elle reste donc
  // soumise à la même permission qu'à la création.
  const requestedScan = source.deployment.scanConfig ?? { scanners: [], failOn: 'NONE' as const };
  const configuresScan = requestedScan.scanners.length > 0 || requestedScan.failOn !== 'NONE';
  if (configuresScan && !auth.can('scan:configure')) {
    throw new ForbiddenError('scan:configure');
  }

  // Les réglages d'instance priment sur la politique héritée : une analyse
  // désactivée ne doit pas revenir par la porte d'un redéploiement.
  const { settings } = await getAppSettings();
  const scanConfig = applySecuritySettings(requestedScan, settings.security);

  const appSpec = parseAppSpec(source.deployment.appSpec);

  const { deployment, steps } = await createDeploymentWithSteps({
    applicationId: id,
    targetId: input.targetId,
    runtime: source.deployment.runtime,
    proxy: source.deployment.proxy,
    scanConfig,
    autoRollback: input.autoRollback,
    appSpec,
    triggeredBy: auth.userId,
    // Le commit suit l'AppSpec : un service qui se construit a besoin du code
    // exact de la version rejouée, pas de la tête actuelle de la branche.
    ...(source.deployment.sourceRepository && source.deployment.sourceSha
      ? {
          source: {
            sourceId: source.deployment.sourceId,
            repository: source.deployment.sourceRepository,
            ref: source.deployment.sourceRef,
            sha: source.deployment.sourceSha,
          },
        }
      : {}),
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
    'redéploiement enfilé',
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
