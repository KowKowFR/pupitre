import { z } from 'zod';
import { invalid, type ValidationRef } from './validation.js';
import { instantOfWallClock, wallClockOf } from './schedule.js';

/**
 * Les fenêtres de maintenance : « prod-1 en maintenance de 22 h à 23 h ».
 *
 * Pendant une fenêtre, les alertes de supervision de ses sujets sont
 * **retenues** au moment de l'envoi — le journal, lui, garde tout. À la fin,
 * ce qui est resté en panne part : une alerte ne se perd jamais, elle attend.
 * Ce module ne porte que des règles pures ; la base tient les fenêtres et les
 * alertes retenues, le worker décide à l'envoi et ferme les fenêtres.
 */

/** Une fenêtre ne dépasse pas un mois : au-delà, c'est une alerte qu'on a coupée. */
export const MAINTENANCE_MAX_DAYS = 31;

/** Ce qu'une fenêtre couvre au plus, pour garder la liste lisible et la requête bornée. */
export const MAINTENANCE_MAX_SUBJECTS = 100;

export type MaintenancePhase = 'upcoming' | 'active' | 'ended';

/** La phase d'une fenêtre à l'instant `now` : la fin est exclue, le début inclus. */
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
 * Les règles d'une fenêtre complète : une fin après le début, une durée bornée,
 * au moins un sujet. Appliquées à la création comme après une modification
 * partielle, sur la fenêtre qui en résulte.
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

/** Une modification partielle : les règles s'appliquent ensuite à la fenêtre entière. */
export const updateMaintenanceSchema = maintenanceFieldsSchema
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, invalid('nothingToChange'));

export type UpdateMaintenanceInput = z.infer<typeof updateMaintenanceSchema>;

// ─── Les alertes retenues ─────────────────────────────────────────────────────

/** Le sujet d'une alerte de supervision, pour savoir si une fenêtre le couvre. */
export type MaintenanceSubject = { type: 'target' | 'monitor' | 'route'; id: string };

/**
 * Comment une alerte se range pendant une maintenance : son sujet, sa
 * **famille** (la panne et le rétablissement d'un même sujet en forment une),
 * et si elle ouvre un problème ou le referme.
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
 * Ce qui part à la fin d'une fenêtre : pour chaque famille, la **dernière**
 * alerte retenue, si elle ouvre un problème. Une panne réparée pendant la
 * maintenance (panne puis rétablissement) ne réveille personne ; une panne
 * toujours là, si.
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

// ─── Saisie dans le fuseau de l'instance ─────────────────────────────────────

/**
 * Un instant, en « AAAA-MM-JJTHH:MM » dans le fuseau de l'instance — la valeur
 * d'un `<input type="datetime-local">`. Le panel affiche ses dates dans ce
 * fuseau : la saisie doit parler le même, pas celui du navigateur.
 */
export function toWallClockInput(instant: Date | string, timeZone: string): string {
  return new Date(wallClockOf(new Date(instant).getTime(), timeZone)).toISOString().slice(0, 16);
}

/** L'inverse : une heure murale saisie dans le fuseau de l'instance, en ISO. `null` si illisible. */
export function fromWallClockInput(value: string, timeZone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number);
  const wall = Date.UTC(year!, month! - 1, day!, hour!, minute!);
  if (Number.isNaN(wall)) return null;
  return new Date(instantOfWallClock(wall, timeZone)).toISOString();
}
