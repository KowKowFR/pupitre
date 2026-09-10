import {
  SCHEDULED_JOB_TYPES,
  scheduledJobDataSchema,
  type ScheduledJobResult,
} from '@tp/core';
import {
  finishScheduledJobRun,
  getScheduledJob,
  logAudit,
  pruneScheduledJobRuns,
  startScheduledJobRun,
  touchScheduledJob,
} from '@tp/db';
import type { Job } from 'bullmq';
import { logger } from '../logger.js';
import { SCHEDULED_JOB_RUNNERS } from '../schedule/runners.js';

/**
 * Enveloppe commune à toutes les tâches planifiées.
 *
 * Elle porte ce qui ne dépend pas du type : relire la ligne en base (une tâche
 * désactivée entre deux occurrences ne doit pas s'exécuter), ouvrir une ligne
 * d'historique, borner le journal, écrire l'audit. Le travail propre au type
 * vit dans `SCHEDULED_JOB_RUNNERS`.
 */

/** Le journal d'une exécution est borné : une tâche bavarde ne remplit pas la base. */
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

  // La base fait foi. Un scheduler resté dans Redis alors que la tâche a été
  // désactivée ne doit rien exécuter — la réconciliation le retirera, mais elle
  // n'a lieu qu'au démarrage du worker.
  const row = await getScheduledJob(data.scheduledJobId);
  if (!row) {
    log.warn('tâche planifiée introuvable en base — occurrence ignorée');
    return {
      scheduledJobId: data.scheduledJobId,
      type: data.type,
      status: 'skipped',
      summary: { reason: 'tâche supprimée' },
    };
  }
  if (!row.enabled && !data.manual) {
    log.info('tâche désactivée — occurrence ignorée');
    return {
      scheduledJobId: row.id,
      type: row.type,
      status: 'skipped',
      summary: { reason: 'tâche désactivée' },
    };
  }

  const definition = SCHEDULED_JOB_TYPES[row.type];
  const run = await startScheduledJobRun({ scheduledJobId: row.id, manual: data.manual });

  const lines: string[] = [];
  const onLog = (line: string): void => {
    if (lines.length < MAX_LOG_LINES) lines.push(line);
    else if (lines.length === MAX_LOG_LINES) lines.push('… journal tronqué');
  };

  log.info({ type: row.type, task: definition.jobName, manual: data.manual }, 'tâche planifiée démarrée');

  try {
    const summary = await SCHEDULED_JOB_RUNNERS[row.type]({
      payload: (row.payload ?? {}) as Record<string, unknown>,
      onLog,
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

    log.info({ summary }, 'tâche planifiée terminée');
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

    log.error({ err: error }, 'tâche planifiée en échec');
    throw error;
  }
}
