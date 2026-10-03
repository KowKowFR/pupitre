import { alertsToRelease, notificationDispatchJobDataSchema } from '@pupitre/core';
import {
  claimMaintenanceEnds,
  claimMaintenanceStarts,
  getMaintenanceWindow,
  heldMaintenanceAlerts,
  logAudit,
  markMaintenanceAlertsReleased,
} from '@pupitre/db';
import type { Job } from 'bullmq';
import { releaseHeldNotification } from '../handlers/notification.js';
import { logger } from '../logger.js';

/**
 * Le balayage des fenêtres de maintenance, chaque minute.
 *
 * La mise en sourdine, elle, n'attend pas ce balayage : la distribution des
 * notifications compare l'heure aux bornes de la fenêtre à chaque alerte. Le
 * balayage ne fait que ce qui doit arriver **une fois** :
 *   - annoncer le début (`maintenance.started`) ;
 *   - à la fin, remettre en distribution ce qui est resté en panne — pour
 *     chaque famille, la dernière alerte retenue si elle ouvre un problème —
 *     puis annoncer la fin (`maintenance.ended`), avec ce qui est parti.
 *
 * Les deux prises (`claimMaintenanceStarts`, `claimMaintenanceEnds`) sont des
 * `UPDATE … RETURNING` : deux balayages qui se croisent ne traitent pas deux
 * fois la même fenêtre, sans verrou de plus.
 */

export const MAINTENANCE_SWEEP_JOB = 'maintenance:sweep' as const;
/** Clé du scheduler BullMQ — sans deux-points. */
export const MAINTENANCE_SWEEP_SCHEDULER_KEY = 'maintenance-sweep';
export const MAINTENANCE_SWEEP_EVERY_MS = 60_000;

export type MaintenanceSweepResult = { started: number; ended: number; released: number };

export async function sweepMaintenance(now: Date = new Date()): Promise<MaintenanceSweepResult> {
  const started = await claimMaintenanceStarts(now);
  for (const row of started) {
    const window = await getMaintenanceWindow(row.id);
    await logAudit({
      actorId: null,
      action: 'maintenance.started',
      resourceType: 'maintenance_window',
      resourceId: row.id,
      after: {
        title: row.title,
        note: row.note,
        startsAt: row.startsAt.toISOString(),
        endsAt: row.endsAt.toISOString(),
        targets: window?.targets.map((target) => target.name) ?? [],
        monitors: window?.monitors.map((monitor) => monitor.name) ?? [],
      },
    });
  }

  let released = 0;
  const ended = await claimMaintenanceEnds(now);
  for (const row of ended) {
    const held = await heldMaintenanceAlerts(row.id);
    const release = alertsToRelease(held.filter((alert) => alert.releasedAt === null));
    for (const alert of release) {
      const parsed = notificationDispatchJobDataSchema.safeParse(alert.data);
      if (!parsed.success) {
        // Une alerte recopiée par une version antérieure et devenue illisible :
        // on le dit plutôt que de la perdre sans un mot.
        logger.error({ windowId: row.id, alertId: alert.id }, 'alerte retenue illisible');
        continue;
      }
      await releaseHeldNotification(parsed.data, `maintenance-release:${alert.id}`);
    }
    await markMaintenanceAlertsReleased(
      release.map((alert) => alert.id),
      now,
    );
    released += release.length;
    await logAudit({
      actorId: null,
      action: 'maintenance.ended',
      resourceType: 'maintenance_window',
      resourceId: row.id,
      after: {
        title: row.title,
        startsAt: row.startsAt.toISOString(),
        endsAt: row.endsAt.toISOString(),
        held: held.length,
        released: release.map((alert) => alert.label),
      },
    });
  }

  return { started: started.length, ended: ended.length, released };
}

export async function handleMaintenanceSweep(job: Job): Promise<MaintenanceSweepResult> {
  const result = await sweepMaintenance();
  if (result.started > 0 || result.ended > 0) {
    logger.info({ jobId: job.id, ...result }, 'balayage des maintenances');
  }
  return result;
}
