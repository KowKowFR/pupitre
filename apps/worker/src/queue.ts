import { OPS_QUEUE } from '@tp/core';
import { Queue } from 'bullmq';
import { createRedisConnection } from './redis.js';

/**
 * Producteur côté worker.
 *
 * Le worker n'était jusqu'ici que consommateur. Le jalon 8 lui donne une
 * seconde casquette : le scheduler installe des repeatable jobs, et la tâche
 * de rafraîchissement des cibles enfile un `target:preflight` par cible plutôt
 * que de dupliquer sa logique. Connexion dédiée : celle du `Worker` est
 * accaparée par des commandes bloquantes.
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

export async function closeOpsQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = null;
  }
}
