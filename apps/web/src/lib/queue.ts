import 'server-only';
import { OPS_QUEUE } from '@pupitre/core';
import { Queue } from 'bullmq';
import { getRedis } from './redis';

declare global {
  var __tpOpsQueue: Queue | undefined;
}

/**
 * Producteur de la queue `ops`.
 * Toute opération longue passe par ici — jamais dans le corps d'une route.
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
