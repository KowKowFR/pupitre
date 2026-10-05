import {
  DEPLOYMENT_DESTROY_JOB,
  DEPLOYMENT_ROLLBACK_JOB,
  DEPLOYMENT_RUN_JOB,
  deployChannel,
} from '@pupitre/core';
import { abandonDeployment, logAudit } from '@pupitre/db';
import { instanceLanguage } from '../language.js';
import { logger } from '../logger.js';
import { workerSay } from '../messages.js';
import { getPublisher } from '../redis.js';

/**
 * Reconciling a deployment whose job just died **without our handler having
 * run**.
 *
 * ── The real case, observed ─────────────────────────────────────────────────
 * BullMQ recovers by itself a job whose worker disappeared: after two passes of
 * the stalled-jobs checker, it goes back to `wait` and a worker picks it up. But
 * at the second recovery — two restarts in flight on a long enough deployment —
 * the counter exceeds `maxStalledCount` and BullMQ sets a "deferred failure" on
 * the job: the next worker fails it ("job stalled more than allowable limit")
 * **without ever calling the handler**. `handleDeploymentRun`'s `catch`, which
 * usually writes the verdict in the database, therefore does not run. The
 * deployment stays `running` forever; destruction refuses it, the purge refuses
 * it, and the application carrying it becomes indelible.
 *
 * ── Why here, and why only here ─────────────────────────────────────────────
 * The worker's `failed` event is the only instant where we know, without
 * guessing anything and without querying the queue, that a job just went into a
 * terminal state. No periodic sweep, no window to choose, no race with a worker
 * that would still be working: the job is dead, we have it from BullMQ itself.
 *
 * And we **resume nothing**. Queuing again a pipeline without knowing where it
 * stopped would redeploy on top of an unknown state — containers half replaced,
 * port already taken, files placed. The deployment is stopped on a failure that
 * names what remains to check on the machine; lifting that uncertainty is a
 * human gesture, with its own permission.
 *
 * Everything else — a job gone from Redis, a deployment stuck before this fix —
 * goes through the manual gesture: `POST /api/deployments/:id/unblock`.
 */

const DEPLOYMENT_JOBS: ReadonlySet<string> = new Set([
  DEPLOYMENT_RUN_JOB,
  DEPLOYMENT_ROLLBACK_JOB,
  DEPLOYMENT_DESTROY_JOB,
]);

function deploymentIdOf(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const value = (data as Record<string, unknown>).deploymentId;
  return typeof value === 'string' ? value : null;
}

function actorOf(data: unknown): { actorId: string | null; ip: string | null } {
  if (typeof data !== 'object' || data === null) return { actorId: null, ip: null };
  const record = data as Record<string, unknown>;
  return {
    actorId: typeof record.actorId === 'string' ? record.actorId : null,
    ip: typeof record.ip === 'string' ? record.ip : null,
  };
}

/**
 * To plug into `worker.on('failed')`. Does nothing — and it is the normal case —
 * when the handler already wrote the verdict: `abandonDeployment()` only touches
 * a deployment still `pending` or `running`, and returns `null` otherwise.
 */
export async function reconcileFailedDeploymentJob(
  job: { name: string; data: unknown } | undefined,
  reason: string,
): Promise<void> {
  if (!job || !DEPLOYMENT_JOBS.has(job.name)) return;

  const deploymentId = deploymentIdOf(job.data);
  if (!deploymentId) return;

  const language = await instanceLanguage();
  const say = workerSay(language);
  const cause = say('abandoned.cause', { job: job.name, reason });

  const report = await abandonDeployment(deploymentId, { cause, language }).catch(
    (error: unknown) => {
      logger.error({ err: error, deploymentId }, 'reconciliation failed');
      return null;
    },
  );
  if (!report) return;

  logger.warn(
    { deploymentId, jobName: job.name, reason, failedStep: report.failedStep },
    'deployment left "in progress" by a dead job: stopped as failed',
  );

  const { actorId, ip } = actorOf(job.data);

  // A viewer still watching the SSE stream must see the verdict fall, rather than
  // a pipeline staying frozen before their eyes.
  getPublisher()
    .publish(
      deployChannel(deploymentId),
      JSON.stringify({
        kind: 'event',
        payload: {
          ts: new Date().toISOString(),
          type: 'deployment',
          key: deploymentId,
          status: 'failed',
          detail: report.error,
        },
      }),
    )
    .catch(() => {});

  await logAudit({
    actorId,
    action: 'deployment.unblocked',
    resourceType: 'deployment',
    resourceId: deploymentId,
    after: {
      status: 'failed',
      failedStep: report.failedStep,
      mayHaveStartedServices: report.mayHaveStartedServices,
      applicationSlug: report.applicationSlug,
      targetName: report.targetName,
      error: report.error,
      detectedBy: say('abandoned.detectedBy', { job: job.name }),
    },
    ip,
  }).catch((error: unknown) => {
    logger.error({ err: error, deploymentId }, 'audit write failed');
  });
}
