import {
  SCHEDULED_JOB_TYPES,
  scheduledJobDataSchema,
  type ScheduledJobResult,
} from '@pupitre/core';
import {
  finishScheduledJobRun,
  getScheduledJob,
  logAudit,
  pruneScheduledJobRuns,
  startScheduledJobRun,
  touchScheduledJob,
} from '@pupitre/db';
import type { Job } from 'bullmq';
import { instanceLanguage } from '../language.js';
import { logger } from '../logger.js';
import { workerSay } from '../messages.js';
import { SCHEDULED_JOB_RUNNERS } from '../schedule/runners.js';

/**
 * The envelope shared by all the scheduled tasks.
 *
 * It carries what does not depend on the type: reading the database row again
 * (a task disabled between two occurrences must not run), opening a history
 * row, bounding the log, writing the audit. The type-specific work lives in
 * `SCHEDULED_JOB_RUNNERS`.
 */

/** A run's log is bounded: a chatty task does not fill up the database. */
const MAX_LOG_LINES = 200;

export async function handleScheduledJob(
  job: Job<unknown, ScheduledJobResult>,
): Promise<ScheduledJobResult> {
  const data = scheduledJobDataSchema.parse(job.data);
  const log = logger.child({
    jobId: job.id,
    jobName: job.name,
    scheduledJobId: data.scheduledJobId,
    key: data.key,
  });

  // The database is authoritative. A scheduler left in Redis while the task was
  // disabled must run nothing — reconciliation will remove it, but it only happens
  // at the worker's startup.
  const say = workerSay(await instanceLanguage());
  const row = await getScheduledJob(data.scheduledJobId);
  if (!row) {
    log.warn('scheduled task not found in the database — occurrence ignored');
    return {
      scheduledJobId: data.scheduledJobId,
      type: data.type,
      status: 'skipped',
      summary: { reason: say('schedule.deleted') },
    };
  }
  if (!row.enabled && !data.manual) {
    log.info('task disabled — occurrence ignored');
    return {
      scheduledJobId: row.id,
      type: row.type,
      status: 'skipped',
      summary: { reason: say('schedule.disabled') },
    };
  }

  const definition = SCHEDULED_JOB_TYPES[row.type];
  const run = await startScheduledJobRun({ scheduledJobId: row.id, manual: data.manual });

  const lines: string[] = [];
  const onLog = (line: string): void => {
    if (lines.length < MAX_LOG_LINES) lines.push(line);
    else if (lines.length === MAX_LOG_LINES) lines.push(say('schedule.truncated'));
  };

  log.info(
    { type: row.type, task: definition.jobName, manual: data.manual },
    'scheduled task started',
  );

  try {
    const summary = await SCHEDULED_JOB_RUNNERS[row.type]({
      payload: (row.payload ?? {}) as Record<string, unknown>,
      onLog,
      say,
    });

    await finishScheduledJobRun(run.id, {
      status: 'success',
      summary: { ...summary, log: lines },
    });
    await touchScheduledJob(row.id);
    await pruneScheduledJobRuns(row.id);

    await logAudit({
      actorId: data.actorId,
      action: 'schedule.run.succeeded',
      resourceType: 'scheduled_job',
      resourceId: row.id,
      after: { key: row.key, type: row.type, manual: data.manual, summary },
      ip: data.ip,
    });

    log.info({ summary }, 'scheduled task completed');
    return { scheduledJobId: row.id, type: row.type, status: 'success', summary };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await finishScheduledJobRun(run.id, {
      status: 'failed',
      summary: { log: lines },
      error: message,
    });
    await touchScheduledJob(row.id);

    await logAudit({
      actorId: data.actorId,
      action: 'schedule.run.failed',
      resourceType: 'scheduled_job',
      resourceId: row.id,
      after: { key: row.key, type: row.type, manual: data.manual, error: message },
      ip: data.ip,
    });

    log.error({ err: error }, 'scheduled task failed');
    throw error;
  }
}
