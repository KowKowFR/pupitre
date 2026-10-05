import { deployChannel, deploymentJobDataSchema, type DeploymentJobResult } from '@pupitre/core';
import { getDriver } from '@pupitre/core/drivers';
import { disconnect, type ConnectOptions } from '@pupitre/core/ssh';
import {
  finishDeployment,
  getDeploymentSummary,
  listLiveDeployments,
  logAudit,
  setDeploymentStopped,
} from '@pupitre/db';
import type { Job } from 'bullmq';
import { logger } from '../logger.js';
import { workerSay } from '../messages.js';
import { openDeploymentContext } from '../deploy/context.js';
import { DeployLogStream } from '../deploy/log-stream.js';
import { runDeploymentPipeline } from '../deploy/pipeline.js';
import { removeCoupleRoutes } from '../proxy/routes.js';
import { getPublisher } from '../redis.js';
import { reportDeploymentStatus } from '../sources/status.js';

/**
 * Pipeline verdict → audit action. A table, not a chain of ternaries: a fourth
 * verdict would be added here and nowhere else.
 *
 * `deployment.rolled_back` says **where** the deployment stands. It is an entry
 * distinct from `deployment.rolled_back.automatic`, written by the pipeline,
 * which says **why** and **to what** — two questions, two traces. Merging them
 * under one name would give two different payloads for one action, and would
 * make the log unreadable to query.
 */
const DEPLOYMENT_AUDIT_ACTION = {
  success: 'deployment.succeeded',
  failed: 'deployment.failed',
  rolled_back: 'deployment.rolled_back',
} as const;

/** Complete deployment: the pipeline, step by step. */
export async function handleDeploymentRun(
  job: Job<unknown, DeploymentJobResult>,
): Promise<DeploymentJobResult> {
  const data = deploymentJobDataSchema.parse(job.data);
  const log = logger.child({ jobId: job.id, deploymentId: data.deploymentId });

  log.info('deployment pipeline started');

  try {
    const outcome = await runDeploymentPipeline(data.deploymentId, getPublisher(), {
      actorId: data.actorId,
      ip: data.ip,
    });

    // What the message will say: "api-invoicing version 12 on prod-1". Without these
    // names, a successful deployment would only be an identifier.
    const summary = await getDeploymentSummary(data.deploymentId).catch(() => null);
    await logAudit({
      actorId: data.actorId,
      action: DEPLOYMENT_AUDIT_ACTION[outcome.status],
      resourceType: 'deployment',
      resourceId: data.deploymentId,
      after: {
        application: summary?.applicationSlug ?? null,
        targetName: summary?.targetName ?? null,
        version: summary?.version ?? null,
        status: outcome.status,
        url: outcome.url,
        publishedPort: outcome.publishedPort,
        failedStep: outcome.failedStep,
        error: outcome.error,
        rolledBackTo: outcome.rolledBackTo,
        automatic: outcome.status === 'rolled_back',
      },
      ip: data.ip,
    });

    log.info({ status: outcome.status, url: outcome.url }, 'pipeline completed');

    // A run coming from a linked repository says its outcome on the GitHub commit.
    await reportDeploymentStatus(data.deploymentId, outcome.status, outcome.failedStep);

    return {
      deploymentId: data.deploymentId,
      status: outcome.status,
      url: outcome.url,
      failedStep: outcome.failedStep,
    };
  } catch (error) {
    // Failure outside the pipeline: target not found, SSH impossible, AppSpec
    // unreadable.
    const message = error instanceof Error ? error.message : String(error);
    log.error({ err: error }, 'pipeline interrupted before its end');

    await finishDeployment(data.deploymentId, 'failed', { error: message });
    getPublisher()
      .publish(
        deployChannel(data.deploymentId),
        JSON.stringify({
          kind: 'event',
          payload: {
            ts: new Date().toISOString(),
            type: 'deployment',
            key: data.deploymentId,
            status: 'failed',
            detail: message,
          },
        }),
      )
      .catch(() => {});

    await logAudit({
      actorId: data.actorId,
      action: 'deployment.failed',
      resourceType: 'deployment',
      resourceId: data.deploymentId,
      after: { error: message },
      ip: data.ip,
    });

    throw error;
  }
}

/** Return to the previous version. */
export async function handleDeploymentRollback(
  job: Job<unknown, DeploymentJobResult>,
): Promise<DeploymentJobResult> {
  const data = deploymentJobDataSchema.parse(job.data);
  const log = logger.child({ jobId: job.id, deploymentId: data.deploymentId });

  const { session, ctx, deployment } = await openDeploymentContext(data.deploymentId);
  const stream = new DeployLogStream(data.deploymentId, getPublisher());

  try {
    if (!ctx.previousDeployment) {
      throw new Error(workerSay(ctx.language)('rollback.noPrevious'));
    }

    stream.event({ type: 'deployment', key: data.deploymentId, status: 'running', detail: null });
    const driver = getDriver(deployment.runtime);
    await driver.rollback(ctx, (line) => stream.line('deploy', line));

    // Informative check: a manually requested rollback stays a successful rollback
    // even if the old version limps. It is the operator who decides what comes next,
    // we give them the information rather than one more status.
    const health = await driver.healthcheck(ctx);
    const say = workerSay(ctx.language);
    stream.line(
      'deploy',
      health.healthy
        ? say('rollback.manual.healthy', {
            version: ctx.previousDeployment.version,
            detail: health.detail ?? '',
          })
        : say('rollback.manual.down', { detail: health.detail ?? say('noDetail') }),
    );

    await finishDeployment(data.deploymentId, 'rolled_back', {
      error: null,
      failedStep: null,
    });

    /**
     * A rollback starts services again: it restarts the previous release with
     * Compose, it scales the replicas back up with Kubernetes. If the application
     * was marked stopped, the mark therefore no longer matches anything, and leaving
     * it would silence the periodic probe on an application that does serve traffic.
     * We reconcile rather than refuse the gesture: the screen warns that going back
     * restarts the application.
     */
    await setDeploymentStopped(data.deploymentId, null);
    stream.event({
      type: 'deployment',
      key: data.deploymentId,
      status: 'rolled_back',
      detail: say('version', { version: ctx.previousDeployment.version }),
    });

    await logAudit({
      actorId: data.actorId,
      action: 'deployment.rolled_back',
      resourceType: 'deployment',
      resourceId: data.deploymentId,
      after: {
        to: ctx.previousDeployment.version,
        toDeploymentId: ctx.previousDeployment.id,
        automatic: false,
        healthy: health.healthy,
      },
      ip: data.ip,
    });

    log.info({ to: ctx.previousDeployment.version }, 'rollback done');

    return {
      deploymentId: data.deploymentId,
      status: 'rolled_back',
      url: null,
      failedStep: null,
    };
  } finally {
    await stream.close();
    await disconnect(session);
  }
}

export type DestroyOptions = {
  actorId: string | null;
  ip: string | null;
  /** Bounds the session opening attempt. Default: the SSH one. */
  connect?: ConnectOptions;
};

/**
 * Destruction: compose down, directory removed, port released, proxy removed.
 *
 * Extracted from the handler so that an application's cascading deletion calls
 * it as is, deployment by deployment. Composing rather than rewriting: the day
 * destruction learns one more gesture — removing a DNS entry, warning a proxy —,
 * the cascade learns it without being touched.
 *
 * It **throws** when the target is unreachable, and that is the contract: it is
 * for the caller to decide whether a failure is fatal or gets reported.
 */
export async function destroyDeployment(
  deploymentId: string,
  options: DestroyOptions,
): Promise<void> {
  const { session, ctx, deployment } = await openDeploymentContext(deploymentId, {
    ...(options.connect ? { connect: options.connect } : {}),
  });
  const stream = new DeployLogStream(deploymentId, getPublisher());

  try {
    const driver = getDriver(deployment.runtime);
    // The domains follow the application in service on the target: destroying a
    // version that no longer is must remove nothing from the proxy.
    const [live] = await listLiveDeployments({
      applicationId: deployment.applicationId,
      targetId: deployment.targetId,
    });
    if (!live?.inService || live.inService.id === deploymentId) {
      await removeCoupleRoutes({
        applicationId: deployment.applicationId,
        targetId: deployment.targetId,
        driver,
        ctx,
        publishedPort: deployment.publishedPort,
        onLog: (line) => stream.line('proxy', line),
      });
    }
    await driver.destroy(ctx, (line) => stream.line('deploy', line));

    await finishDeployment(deploymentId, 'destroyed', { url: null, publishedPort: null });
    stream.event({
      type: 'deployment',
      key: deploymentId,
      status: 'destroyed',
      detail: null,
    });

    await logAudit({
      actorId: options.actorId,
      action: 'deployment.destroyed',
      resourceType: 'deployment',
      resourceId: deploymentId,
      ip: options.ip,
    });
  } finally {
    await stream.close();
    await disconnect(session);
  }
}

/** Single destruction, triggered from `DELETE /api/deployments/:id`. */
export async function handleDeploymentDestroy(
  job: Job<unknown, DeploymentJobResult>,
): Promise<DeploymentJobResult> {
  const data = deploymentJobDataSchema.parse(job.data);
  const log = logger.child({ jobId: job.id, deploymentId: data.deploymentId });

  await destroyDeployment(data.deploymentId, { actorId: data.actorId, ip: data.ip });
  log.info('deployment destroyed');

  return { deploymentId: data.deploymentId, status: 'destroyed', url: null, failedStep: null };
}
