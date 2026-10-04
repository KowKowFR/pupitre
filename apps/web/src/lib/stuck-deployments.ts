import 'server-only';
import {
  STUCK_DEPLOYMENT_GRACE_MS,
  UNFINISHED_JOB_STATES,
  jobMayAdvanceDeployment,
  type UnfinishedJobState,
} from '@pupitre/core';
import { listUnfinishedDeployments, type UnfinishedDeployment } from '@pupitre/db';
import type { Queue } from 'bullmq';
import { deployments } from '@/i18n/messages/deployments';
import { msg, type MessageRef } from '@/lib/errors';

/**
 * The verdict on a deployment the database believes in progress.
 *
 * The rule lives in `@pupitre/core` (`UNFINISHED_JOB_STATES`,
 * `jobMayAdvanceDeployment`); this module is only the glue that reads it in
 * Redis. `@pupitre/core` does not depend on `bullmq` — it describes the queues'
 * contract, it opens none — and it is this separation that allows the worker to
 * apply exactly the same rule without the decision being written twice.
 */
export type StuckVerdict = {
  deployment: UnfinishedDeployment;
  /**
   * No runnable job carries this deployment any more: it is a proven ghost, not an
   * assumption.
   */
  ghost: boolean;
  /** The job that can still act, when there is one — it is the one that clears it. */
  job: { id: string; name: string; state: UnfinishedJobState } | null;
  /** The row's age. Serves the diagnosis, never the verdict. */
  ageMs: number;
  /** Within the queuing grace window: we do not conclude yet. */
  tooRecent: boolean;
};

type LiveJob = { id: string; name: string; data: unknown; state: UnfinishedJobState };

/**
 * All the `ops` queue's jobs still likely to run.
 *
 * Read state by state — and not in one go — because the verdict must be able to
 * **name** the state that clears the deployment: "your job has been active for
 * four minutes" is an answer, "it exists" is not one.
 *
 * The volume is bounded by nature: these states only contain what is left to do.
 * The thousands of finished jobs are never gone through.
 */
async function listLiveJobs(queue: Queue): Promise<LiveJob[]> {
  const perState = await Promise.all(
    UNFINISHED_JOB_STATES.map(async (state) => {
      const jobs = await queue.getJobs([state]);
      return jobs
        .filter((job): job is typeof job & { id: string } => typeof job.id === 'string')
        .map((job) => ({ id: job.id, name: job.name, data: job.data as unknown, state }));
    }),
  );
  return perState.flat();
}

function verdictFor(
  deployment: UnfinishedDeployment,
  live: readonly LiveJob[],
  now: number,
): StuckVerdict {
  const ageMs = now - deployment.createdAt.getTime();
  const tooRecent = ageMs < STUCK_DEPLOYMENT_GRACE_MS;

  const job =
    live.find((candidate) =>
      jobMayAdvanceDeployment(candidate, {
        deploymentId: deployment.id,
        applicationId: deployment.applicationId,
      }),
    ) ?? null;

  return {
    deployment,
    ghost: job === null && !tooRecent,
    job: job ? { id: job.id, name: job.name, state: job.state } : null,
    ageMs,
    tooRecent,
  };
}

/** Everything the database believes in progress, with each one's verdict. */
export async function inspectUnfinishedDeployments(queue: Queue): Promise<StuckVerdict[]> {
  const unfinished = await listUnfinishedDeployments();
  if (unfinished.length === 0) return [];

  const live = await listLiveJobs(queue);
  const now = Date.now();
  return unfinished.map((deployment) => verdictFor(deployment, live, now));
}

/**
 * A single deployment's verdict. `null` when it is no longer "in progress" — it
 * concluded, or it does not exist.
 */
export async function inspectDeployment(
  queue: Queue,
  deploymentId: string,
): Promise<StuckVerdict | null> {
  const unfinished = await listUnfinishedDeployments();
  const deployment = unfinished.find((row) => row.id === deploymentId);
  if (!deployment) return null;

  return verdictFor(deployment, await listLiveJobs(queue), Date.now());
}

/**
 * Why we refuse to declare this deployment stuck.
 *
 * A **reference** and not a sentence: the function is synchronous and has no way
 * of reading the instance's language. It is `apiRoute()` that will render the
 * text, as for all the panel's errors.
 */
export function refusalMessage(verdict: StuckVerdict): MessageRef {
  if (verdict.job) {
    return msg(deployments, 'unblock.refusal.job', {
      name: verdict.job.name,
      id: verdict.job.id,
      state: verdict.job.state,
      count: Math.max(1, Math.round(verdict.ageMs / 60_000)),
    });
  }

  return msg(deployments, 'unblock.refusal.tooRecent', {
    seconds: Math.round(verdict.ageMs / 1000),
  });
}
