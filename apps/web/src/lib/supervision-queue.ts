import 'server-only';
import { SUPERVISION_QUEUE } from '@tp/core';
import { Queue } from 'bullmq';
import { getRedis } from './redis';

declare global {
  var __tpSupervisionQueue: Queue | undefined;
}

/**
 * File dédiée à la supervision. Séparée de `ops` pour qu'un flux de logs, qui
 * occupe son slot pendant toute la consultation, ne retarde jamais un
 * déploiement.
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
