import { BACKUPS_QUEUE, OPS_QUEUE, SUPERVISION_QUEUE } from '@pupitre/core';
import { Queue } from 'bullmq';
import { createRedisConnection } from './redis.js';

/**
 * Producer on the worker side.
 *
 * The worker was originally only a consumer. Scheduling gives it a second hat:
 * the scheduler installs repeatable jobs, and the targets refresh task queues a
 * `target:preflight` per target rather than duplicate its logic. A dedicated
 * connection: the `Worker`'s is monopolized by blocking commands.
 */

let queue: Queue | null = null;

export function getOpsQueue(): Queue {
  queue ??= new Queue(OPS_QUEUE, {
    connection: createRedisConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { age: 24 * 3600, count: 1000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    },
  });
  return queue;
}

let supervisionQueue: Queue | null = null;

/**
 * Producer on the monitoring queue.
 *
 * The worker installs the probes sweep's scheduler there. It is its own producer
 * for that job: it has no database row to reconcile, it is a clock, not domain
 * data.
 */
export function getSupervisionQueue(): Queue {
  supervisionQueue ??= new Queue(SUPERVISION_QUEUE, {
    connection: createRedisConnection(),
    defaultJobOptions: {
      // A sweep that fails is not replayed: the next one comes in thirty seconds and
      // the probes are still due. Replaying would mean probing the same site twice for
      // nothing.
      attempts: 1,
      removeOnComplete: { age: 3600, count: 100 },
      removeOnFail: { age: 24 * 3600, count: 100 },
    },
  });
  return supervisionQueue;
}

let backupsQueue: Queue | null = null;

/**
 * The backups queue. One attempt: a failed backup is notified, not replayed
 * blindly — the next one runs the following night, and a "Back up now" stays
 * within reach.
 */
export function getBackupsQueue(): Queue {
  backupsQueue ??= new Queue(BACKUPS_QUEUE, {
    connection: createRedisConnection(),
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { age: 7 * 24 * 3600, count: 500 },
      removeOnFail: { age: 30 * 24 * 3600, count: 500 },
    },
  });
  return backupsQueue;
}

export async function closeOpsQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = null;
  }
  if (supervisionQueue) {
    await supervisionQueue.close();
    supervisionQueue = null;
  }
  if (backupsQueue) {
    await backupsQueue.close();
    backupsQueue = null;
  }
}
