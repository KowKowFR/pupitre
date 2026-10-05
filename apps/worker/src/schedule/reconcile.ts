import { SCHEDULED_JOB_TYPES, type ScheduledJobData } from '@pupitre/core';
import { listScheduledJobs, logAudit, type ScheduledJob } from '@pupitre/db';
import type { Queue } from 'bullmq';
import { logger } from '../logger.js';

/**
 * Database ↔ BullMQ reconciliation.
 *
 * The database is the source of truth, Redis is only the executor. At the
 * worker's startup we bring both into agreement:
 *
 *   - a task active in the database and absent from Redis is (re)installed there;
 *   - a task whose cron or time zone changed is reinstalled with them;
 *   - a task disabled or deleted in the database is removed from Redis;
 *   - an orphan scheduler — a leftover of a previous version of the code, or of
 *     a task deleted while the worker was off — is removed.
 *
 * That is what lets a `docker compose restart worker`, or an unfortunate
 * `FLUSHALL`, lose nothing. Without this step, a restarted worker would inherit
 * Redis's state, which can be anything.
 */

export type ReconcileReport = {
  installed: string[];
  updated: string[];
  removed: string[];
  unchanged: string[];
};

function templateFor(row: ScheduledJob): { name: string; data: ScheduledJobData } {
  const definition = SCHEDULED_JOB_TYPES[row.type];
  return {
    name: definition.jobName,
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

/** Installs or updates a task's scheduler. Idempotent. */
async function upsertScheduler(queue: Queue, row: ScheduledJob): Promise<void> {
  const template = templateFor(row);
  // The same call as in `apps/web/src/lib/schedules.ts`, `tz` included: both
  // producers write the same scheduler, they cannot diverge on the time zone
  // without the task starting to run at two different times depending on who
  // reinstalled it last.
  await queue.upsertJobScheduler(
    row.key,
    { pattern: row.cron, tz: row.timezone },
    {
      name: template.name,
      data: template.data,
      opts: {
        // A periodic task that fails must not be replayed three times: the next
        // occurrence comes anyway, and three scans in a row on the same image say
        // nothing more than the first.
        attempts: 1,
        removeOnComplete: { age: 24 * 3600, count: 200 },
        removeOnFail: { age: 7 * 24 * 3600, count: 200 },
      },
    },
  );
}

async function removeScheduler(queue: Queue, key: string): Promise<void> {
  await queue.removeJobScheduler(key);
}

export async function reconcileSchedulers(queue: Queue): Promise<ReconcileReport> {
  const rows = await listScheduledJobs();
  const existing = await queue.getJobSchedulers(0, -1, true);
  const byKey = new Map(existing.map((scheduler) => [scheduler.key, scheduler]));

  const report: ReconcileReport = { installed: [], updated: [], removed: [], unchanged: [] };
  const wanted = new Set<string>();

  for (const row of rows) {
    if (!row.enabled) {
      if (byKey.has(row.key)) {
        await removeScheduler(queue, row.key);
        report.removed.push(row.key);
      }
      continue;
    }

    wanted.add(row.key);
    const current = byKey.get(row.key);
    if (!current) {
      await upsertScheduler(queue, row);
      report.installed.push(row.key);
      continue;
    }

    // The pattern and the time zone are the only two things BullMQ returns to us in
    // a comparable way; the template's data is rewritten at each upsert. A scheduler
    // older than migration `0009` has no `tz`: it counts as a gap, and will be
    // reinstalled with its row's.
    if (current.pattern !== row.cron || (current.tz ?? null) !== row.timezone) {
      await upsertScheduler(queue, row);
      report.updated.push(row.key);
      continue;
    }

    // Silent rewrite: the template's content may have changed (a modified `payload`,
    // a recreated task identifier) without the cron moving.
    await upsertScheduler(queue, row);
    report.unchanged.push(row.key);
  }

  for (const scheduler of existing) {
    if (!wanted.has(scheduler.key)) {
      await removeScheduler(queue, scheduler.key);
      report.removed.push(scheduler.key);
    }
  }

  logger.info(
    {
      installed: report.installed,
      updated: report.updated,
      removed: report.removed,
      unchanged: report.unchanged.length,
    },
    'scheduled tasks reconciled with BullMQ',
  );

  if (report.installed.length > 0 || report.updated.length > 0 || report.removed.length > 0) {
    await logAudit({
      action: 'schedule.reconciled',
      resourceType: 'scheduled_job',
      after: {
        installed: report.installed,
        updated: report.updated,
        removed: report.removed,
      },
    });
  }

  return report;
}
