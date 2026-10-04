import 'server-only';
import { SUPERVISION_QUEUE } from '@pupitre/core';
import { Queue } from 'bullmq';
import { getRedis } from './redis';

declare global {
  var __tpSupervisionQueue: Queue | undefined;
}

/**
 * The queue dedicated to monitoring. Separate from `ops` so that a log stream,
 * which takes its slot for the whole viewing, never delays a deployment.
 */
export function getSupervisionQueue(): Queue {
  globalThis.__tpSupervisionQueue ??= new Queue(SUPERVISION_QUEUE, {
    connection: getRedis(),
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { age: 3600, count: 100 },
      removeOnFail: { age: 24 * 3600 },
    },
  });
  return globalThis.__tpSupervisionQueue;
}
