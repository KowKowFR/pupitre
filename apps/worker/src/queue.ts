import { BACKUPS_QUEUE, OPS_QUEUE, SUPERVISION_QUEUE } from '@pupitre/core';
import { Queue } from 'bullmq';
import { createRedisConnection } from './redis.js';

/**
 * Producteur côté worker.
 *
 * Le worker n'était à l'origine que consommateur. L'ordonnancement lui donne une
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

let supervisionQueue: Queue | null = null;

/**
 * Producteur sur la file de supervision.
 *
 * Le worker y installe le scheduler du balayage des sondes. Il est son propre
 * producteur pour cette tâche-là : elle n'a pas de ligne en base à réconcilier,
 * c'est une horloge, pas une donnée du domaine.
 */
export function getSupervisionQueue(): Queue {
  supervisionQueue ??= new Queue(SUPERVISION_QUEUE, {
    connection: createRedisConnection(),
    defaultJobOptions: {
      // Un balayage qui rate n'est pas rejoué : le suivant arrive dans trente
      // secondes et les sondes sont toujours dues. Rejouer reviendrait à sonder
      // deux fois le même site pour rien.
      attempts: 1,
      removeOnComplete: { age: 3600, count: 100 },
      removeOnFail: { age: 24 * 3600, count: 100 },
    },
  });
  return supervisionQueue;
}

let backupsQueue: Queue | null = null;

/**
 * La file des sauvegardes. Une tentative : une sauvegarde ratée est notifiée,
 * pas rejouée à l'aveugle — la suivante passe la nuit prochaine, et un
 * « Sauvegarder maintenant » reste à portée.
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
