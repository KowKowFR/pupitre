import 'server-only';
import { SCHEDULED_JOB_TYPES, type ScheduledJobData } from '@pupitre/core';
import type { ScheduledJob } from '@pupitre/db';
import { getOpsQueue } from './queue';
import { logger } from './logger';

/**
 * Miroir BullMQ des tâches planifiées, côté panel.
 *
 * Le panel écrit en base *et* dans Redis, dans cet ordre : la base fait foi,
 * Redis exécute. Si l'écriture Redis échoue, la base reste juste et le worker
 * rattrapera l'écart à son prochain démarrage — c'est exactement le rôle de la
 * réconciliation. L'inverse (Redis à jour, base en retard) laisserait tourner
 * une tâche que plus personne ne voit.
 */

function templateFor(row: ScheduledJob): { name: string; data: ScheduledJobData } {
  return {
    name: SCHEDULED_JOB_TYPES[row.type].jobName,
    data: {
      scheduledJobId: row.id,
      type: row.type,
      key: row.key,
      payload: (row.payload ?? {}) as Record<string, unknown>,
      actorId: null,
      ip: null,
      manual: false,
    },
  };
}

/** Installe ou met à jour le scheduler. Retiré si la tâche est désactivée. */
export async function syncScheduler(row: ScheduledJob): Promise<void> {
  const queue = getOpsQueue();
  if (!row.enabled) {
    await queue.removeJobScheduler(row.key);
    return;
  }

  const template = templateFor(row);
  // `tz` n'est pas optionnel : sans lui, cron-parser retomberait sur le fuseau
  // du process — UTC dans nos conteneurs — et l'heure affichée par le panel ne
  // serait plus celle à laquelle la tâche tourne.
  await queue.upsertJobScheduler(
    row.key,
    { pattern: row.cron, tz: row.timezone },
    {
      name: template.name,
      data: template.data,
      opts: {
        attempts: 1,
        removeOnComplete: { age: 24 * 3600, count: 200 },
        removeOnFail: { age: 7 * 24 * 3600, count: 200 },
      },
    },
  );
}

export async function removeScheduler(key: string): Promise<void> {
  await getOpsQueue().removeJobScheduler(key);
}

/** Déclenchement manuel : une occurrence hors scheduler, tracée comme telle. */
export async function triggerNow(
  row: ScheduledJob,
  actor: { userId: string; ip: string | null },
): Promise<string | null> {
  const template = templateFor(row);
  const job = await getOpsQueue().add(
    template.name,
    { ...template.data, actorId: actor.userId, ip: actor.ip, manual: true },
    { attempts: 1 },
  );
  return job.id ?? null;
}

export type SchedulerState = {
  /** Prochaine occurrence, telle que BullMQ l'a calculée. */
  nextRunAt: string | null;
  /**
   * Fuseau mémorisé par BullMQ. Rendu tel quel pour que l'écart avec la base
   * soit visible plutôt que deviné : `null` désigne un scheduler installé avant
   * la migration `0009`, donc interprété dans le fuseau du process.
   */
  timeZone: string | null;
  installed: boolean;
};

/**
 * État des schedulers, lu dans Redis.
 *
 * La prochaine occurrence vient de BullMQ et n'est pas recalculée ici : c'est
 * lui qui ordonnance, et deux calculs de cron indépendants finiraient par ne
 * plus dire la même chose.
 */
export async function schedulerStates(): Promise<Map<string, SchedulerState>> {
  const states = new Map<string, SchedulerState>();
  try {
    const schedulers = await getOpsQueue().getJobSchedulers(0, -1, true);
    for (const scheduler of schedulers) {
      states.set(scheduler.key, {
        nextRunAt: scheduler.next ? new Date(scheduler.next).toISOString() : null,
        timeZone: scheduler.tz ?? null,
        installed: true,
      });
    }
  } catch (error) {
    logger.error({ err: error }, 'lecture des schedulers BullMQ impossible');
  }
  return states;
}
