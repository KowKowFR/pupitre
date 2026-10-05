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
 * The maintenance windows sweep, every minute.
 *
 * Muting does not wait for this sweep: the notification delivery compares the
 * time with the window's bounds at each alert. The sweep only does what must
 * happen **once**:
 *   - announce the start (`maintenance.started`);
 *   - at the end, put back into delivery what stayed down — for each family, the
 *     last held alert if it opens a problem — then announce the end
 *     (`maintenance.ended`), with what went out.
 *
 * The two claims (`claimMaintenanceStarts`, `claimMaintenanceEnds`) are
 * `UPDATE … RETURNING`s: two sweeps that cross do not handle the same window
 * twice, without an extra lock.
 */

export const MAINTENANCE_SWEEP_JOB = 'maintenance:sweep' as const;
/** BullMQ scheduler key — without a colon. */
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
        // An alert copied by an earlier version and become unreadable: we say so rather
        // than lose it without a word.
        logger.error({ windowId: row.id, alertId: alert.id }, 'held alert unreadable');
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
    logger.info({ jobId: job.id, ...result }, 'maintenance sweep');
  }
  return result;
}
