import 'server-only';
import { OPS_QUEUE } from '@pupitre/core';
import { Queue } from 'bullmq';
import { getRedis } from './redis';

declare global {
  var __tpOpsQueue: Queue | undefined;
}

/**
 * The `ops` queue's producer. Every long-running operation goes through here —
 * never in a route's body.
 */
export function getOpsQueue(): Queue {
  globalThis.__tpOpsQueue ??= new Queue(OPS_QUEUE, {
    connection: getRedis(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { age: 24 * 3600, count: 1000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    },
  });
  return globalThis.__tpOpsQueue;
}
