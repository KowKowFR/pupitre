import { SCHEDULED_JOB_TYPES, type ScheduledJobData } from '@pupitre/core';
import { listScheduledJobs, logAudit, type ScheduledJob } from '@pupitre/db';
import type { Queue } from 'bullmq';
import { logger } from '../logger.js';

/**
 * Réconciliation base ↔ BullMQ.
 *
 * La base est la source de vérité, Redis n'est que l'exécutant. Au démarrage du
 * worker on remet les deux d'accord :
 *
 *   - une tâche active en base et absente de Redis y est (ré)installée ;
 *   - une tâche dont le cron ou le fuseau a changé est réinstallée avec eux ;
 *   - une tâche désactivée ou supprimée en base est retirée de Redis ;
 *   - un scheduler orphelin — reliquat d'une version précédente du code, ou
 *     d'une tâche supprimée pendant que le worker était éteint — est retiré.
 *
 * C'est ce qui permet à un `docker compose restart worker`, ou à un `FLUSHALL`
 * malencontreux, de ne rien perdre. Sans cette étape, un worker redémarré
 * hériterait de l'état de Redis, qui peut être n'importe lequel.
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

/** Installe ou met à jour le scheduler d'une tâche. Idempotent. */
export async function upsertScheduler(queue: Queue, row: ScheduledJob): Promise<void> {
  const template = templateFor(row);
  // Même appel que dans `apps/web/src/lib/schedules.ts`, `tz` compris : les deux
  // producteurs écrivent le même scheduler, ils ne peuvent pas diverger sur le
  // fuseau sans que la tâche se mette à tourner à deux heures différentes selon
  // qui l'a réinstallée en dernier.
  await queue.upsertJobScheduler(
    row.key,
    { pattern: row.cron, tz: row.timezone },
    {
      name: template.name,
      data: template.data,
      opts: {
        // Une tâche périodique qui échoue ne doit pas être rejouée trois fois :
        // la prochaine occurrence arrive de toute façon, et trois scans en
        // rafale sur la même image ne disent rien de plus que le premier.
        attempts: 1,
        removeOnComplete: { age: 24 * 3600, count: 200 },
        removeOnFail: { age: 7 * 24 * 3600, count: 200 },
      },
    },
  );
}

export async function removeScheduler(queue: Queue, key: string): Promise<void> {
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

    // Le motif et le fuseau sont les deux seules choses que BullMQ nous rende de
    // façon comparable ; les données du template, elles, sont réécrites à chaque
    // upsert. Un scheduler antérieur à la migration `0009` n'a pas de `tz` : il
    // compte comme un écart, et sera réinstallé avec celui de sa ligne.
    if (current.pattern !== row.cron || (current.tz ?? null) !== row.timezone) {
      await upsertScheduler(queue, row);
      report.updated.push(row.key);
      continue;
    }

    // Réécriture silencieuse : le contenu du template peut avoir changé (un
    // `payload` modifié, un identifiant de tâche recréé) sans que le cron bouge.
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
    'tâches planifiées réconciliées avec BullMQ',
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
