import { z } from 'zod';
import { invalid, type ValidationRef } from './validation.js';
import { instantOfWallClock, wallClockOf } from './schedule.js';

/**
 * Maintenance windows: "prod-1 under maintenance from 10 pm to 11 pm".
 *
 * During a window, the monitoring alerts of its subjects are **held** at send
 * time — the log keeps everything. At the end, what stayed down goes out: an
 * alert is never lost, it waits. This module only carries pure rules; the
 * database holds the windows and the held alerts, the worker decides at send
 * time and closes the windows.
 */

/** A window does not exceed a month: beyond that, it is an alert that was turned off. */
export const MAINTENANCE_MAX_DAYS = 31;

/** What a window covers at most, to keep the list readable and the query bounded. */
export const MAINTENANCE_MAX_SUBJECTS = 100;

export type MaintenancePhase = 'upcoming' | 'active' | 'ended';

/** A window's phase at instant `now`: the end is excluded, the start included. */
export function maintenancePhase(
  window: { startsAt: Date | string; endsAt: Date | string },
  now: number = Date.now(),
): MaintenancePhase {
  if (now < new Date(window.startsAt).getTime()) return 'upcoming';
  if (now < new Date(window.endsAt).getTime()) return 'active';
  return 'ended';
}

const isoInstant = z.string().datetime({ offset: true });

const maintenanceFieldsSchema = z.object({
  title: z.string().trim().min(1).max(120),
  note: z.string().trim().max(1000).nullable(),
  startsAt: isoInstant,
  endsAt: isoInstant,
  targetIds: z.array(z.string().uuid()).max(MAINTENANCE_MAX_SUBJECTS),
  monitorIds: z.array(z.string().uuid()).max(MAINTENANCE_MAX_SUBJECTS),
});

export type MaintenanceFields = z.infer<typeof maintenanceFieldsSchema>;

/**
 * The rules of a complete window: an end after the start, a bounded duration, at
 * least one subject. Applied at creation as after a partial change, on the
 * resulting window.
 */
export function maintenanceProblems(
  fields: MaintenanceFields,
): Array<{ path: 'endsAt' | 'targetIds'; problem: ValidationRef }> {
  const problems: Array<{ path: 'endsAt' | 'targetIds'; problem: ValidationRef }> = [];
  const start = new Date(fields.startsAt).getTime();
  const end = new Date(fields.endsAt).getTime();
  if (end <= start)
    problems.push({ path: 'endsAt', problem: { key: 'maintenance.endBeforeStart' } });
  if (end - start > MAINTENANCE_MAX_DAYS * 86_400_000) {
    problems.push({
      path: 'endsAt',
      problem: { key: 'maintenance.tooLong', vars: { days: MAINTENANCE_MAX_DAYS } },
    });
  }
  if (fields.targetIds.length + fields.monitorIds.length === 0) {
    problems.push({ path: 'targetIds', problem: { key: 'maintenance.noSubject' } });
  }
  return problems;
}

export const createMaintenanceSchema = maintenanceFieldsSchema
  .extend({
    note: maintenanceFieldsSchema.shape.note.default(null),
    targetIds: maintenanceFieldsSchema.shape.targetIds.default([]),
    monitorIds: maintenanceFieldsSchema.shape.monitorIds.default([]),
  })
  .superRefine((fields, ctx) => {
    for (const { path, problem } of maintenanceProblems(fields)) {
      ctx.addIssue({ code: 'custom', path: [path], ...invalid(problem.key, problem.vars) });
    }
  });

export type CreateMaintenanceInput = z.infer<typeof createMaintenanceSchema>;

/** A partial change: the rules then apply to the whole window. */
export const updateMaintenanceSchema = maintenanceFieldsSchema
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, invalid('nothingToChange'));

export type UpdateMaintenanceInput = z.infer<typeof updateMaintenanceSchema>;

// ─── Held alerts ──────────────────────────────────────────────────────────────

/** The subject of a monitoring alert, to know whether a window covers it. */
export type MaintenanceSubject = { type: 'target' | 'monitor' | 'route'; id: string };

/**
 * How an alert is filed during maintenance: its subject, its **family** (the
 * outage and the recovery of the same subject form one), and whether it opens a
 * problem or closes it.
 */
export type MaintenanceRule = {
  readonly subject: (entry: {
    resourceId: string | null;
    after: unknown;
  }) => MaintenanceSubject | null;
  readonly family: (entry: { resourceId: string | null; after: unknown }) => string;
  readonly opens: boolean;
};

export type HeldAlert = { id: string; family: string; opens: boolean; heldAt: Date };

/**
 * What goes out at the end of a window: for each family, the **last** held
 * alert, if it opens a problem. An outage repaired during the maintenance
 * (outage then recovery) wakes nobody up; an outage still there does.
 */
export function alertsToRelease<T extends HeldAlert>(held: readonly T[]): T[] {
  const latest = new Map<string, T>();
  for (const alert of held) {
    const current = latest.get(alert.family);
    if (!current || alert.heldAt.getTime() >= current.heldAt.getTime()) {
      latest.set(alert.family, alert);
    }
  }
  return [...latest.values()]
    .filter((alert) => alert.opens)
    .sort((a, b) => a.heldAt.getTime() - b.heldAt.getTime());
}

// ─── Input in the instance's time zone ───────────────────────────────────────

/**
 * An instant, as "YYYY-MM-DDTHH:MM" in the instance's time zone — the value of a
 * `<input type="datetime-local">`. The panel shows its dates in that time zone:
 * input must speak the same one, not the browser's.
 */
export function toWallClockInput(instant: Date | string, timeZone: string): string {
  return new Date(wallClockOf(new Date(instant).getTime(), timeZone)).toISOString().slice(0, 16);
}

/** The reverse: a wall-clock time in the instance's time zone, as ISO. `null` if unreadable. */
export function fromWallClockInput(value: string, timeZone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number);
  const wall = Date.UTC(year!, month! - 1, day!, hour!, minute!);
  if (Number.isNaN(wall)) return null;
  return new Date(instantOfWallClock(wall, timeZone)).toISOString();
}
