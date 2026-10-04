import 'server-only';
import { SCHEDULED_JOB_TYPES, type ScheduledJobData } from '@pupitre/core';
import type { ScheduledJob } from '@pupitre/db';
import { getOpsQueue } from './queue';
import { logger } from './logger';

/**
 * The BullMQ mirror of the scheduled tasks, panel side.
 *
 * The panel writes to the database *and* to Redis, in that order: the database is
 * authoritative, Redis executes. If the Redis write fails, the database stays
 * right and the worker will catch up the gap at its next start — that is exactly
 * reconciliation's role. The reverse (Redis up to date, database behind) would
 * leave running a task nobody sees any more.
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

/** Installs or updates the scheduler. Removed if the task is disabled. */
export async function syncScheduler(row: ScheduledJob): Promise<void> {
  const queue = getOpsQueue();
  if (!row.enabled) {
    await queue.removeJobScheduler(row.key);
    return;
  }

  const template = templateFor(row);
  // `tz` is not optional: without it, cron-parser would fall back on the process's
  // time zone — UTC in our containers — and the time shown by the panel would no
  // longer be the one at which the task runs.
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

/** A manual trigger: an occurrence outside the scheduler, traced as such. */
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
  /** The next occurrence, as BullMQ computed it. */
  nextRunAt: string | null;
  /**
   * The time zone stored by BullMQ. Returned as is so that the gap with the database
   * is visible rather than guessed: `null` designates a scheduler installed before
   * migration `0009`, hence interpreted in the process's time zone.
   */
  timeZone: string | null;
  installed: boolean;
};

/**
 * The schedulers' state, read in Redis.
 *
 * The next occurrence comes from BullMQ and is not recomputed here: it is the one
 * that schedules, and two independent cron computations would end up no longer
 * saying the same thing.
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
    logger.error({ err: error }, 'BullMQ schedulers could not be read');
  }
  return states;
}
