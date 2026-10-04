import {
  SCHEDULED_JOB_TYPES,
  cronSchema,
  scheduleTimeZoneSchema,
  scheduledJobTypeSchema,
  simpleScheduleSchema,
  toCron,
  type ScheduledJobType,
  invalid,
} from '@pupitre/core';
import { and, asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type Database } from './client.js';
import { scheduledJobRuns, scheduledJobs } from './schema/ops.js';
import { getAppSettingsValue } from './settings.js';

/**
 * Persistance des tâches planifiées.
 *
 * La base est la **source de vérité** ; BullMQ n'en est que le miroir
 * d'exécution. Le worker réconcilie l'un sur l'autre à chaque démarrage : une
 * tâche désactivée ici disparaît de Redis, une tâche présente ici et absente de
 * Redis y est recréée. C'est ce qui permet à un redémarrage du worker — ou à un
 * `docker compose down` — de ne rien perdre.
 */

export type ScheduledJob = typeof scheduledJobs.$inferSelect;
export type ScheduledJobRun = typeof scheduledJobRuns.$inferSelect;

/** Une clé BullMQ : lisible, stable, utilisable dans une URL et dans Redis. */
const keySchema = z
  .string()
  .trim()
  .min(3)
  .max(120)
  .regex(/^[a-z0-9]+(?:[:._-][a-z0-9]+)*$/, 'clé en minuscules, séparateurs `: . _ -`');

/**
 * Cadence : une expression cron, ou une périodicité simplifiée.
 *
 * Le mode simplifié de l'écran est une **commodité de saisie** ; le serveur ne
 * fait pas confiance au client pour autant. `schedule` est converti ici par
 * `toCron()` puis validé par `cronSchema`, exactement comme une expression
 * écrite à la main : il n'existe qu'un seul chemin de validation, et un seul
 * format persisté.
 *
 * Fournir les deux à la fois est refusé — deux cadences dans un même corps de
 * requête, il faudrait en choisir une, et choisir à la place de l'appelant est
 * la meilleure façon de planifier autre chose que ce qu'il demandait.
 */
const cadenceFields = {
  cron: cronSchema.optional(),
  schedule: simpleScheduleSchema.optional(),
} as const;

function resolveCadence(
  input: { cron?: string; schedule?: z.infer<typeof simpleScheduleSchema> },
  ctx: z.RefinementCtx,
  required: boolean,
): string | undefined {
  if (input.cron !== undefined && input.schedule !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['cron'],
      ...invalid('schedules.cronOrSchedule'),
    });
    return undefined;
  }

  if (input.schedule !== undefined) {
    const rendered = toCron(input.schedule);
    // La conversion est censée produire une expression valide ; on la revalide
    // quand même, pour que `cronSchema` reste l'unique porte d'entrée.
    const parsed = cronSchema.safeParse(rendered);
    if (!parsed.success) {
      ctx.addIssue({
        code: 'custom',
        path: ['schedule'],
        ...invalid('schedules.unreadable', { value: rendered }),
      });
      return undefined;
    }
    return parsed.data;
  }

  if (input.cron !== undefined) return input.cron;

  if (required) {
    ctx.addIssue({ code: 'custom', path: ['cron'], message: 'cadence manquante' });
  }
  return undefined;
}

export const createScheduledJobSchema = z
  .object({
    key: keySchema.optional(),
    type: scheduledJobTypeSchema,
    ...cadenceFields,
    /**
     * Absent = fuseau des paramètres d'instance, résolu par
     * `createScheduledJob()`. Pas de défaut Zod ici : le défaut demande une
     * lecture en base, et un schéma ne lit rien.
     */
    timezone: scheduleTimeZoneSchema.optional(),
    payload: z.record(z.string(), z.unknown()).default({}),
    enabled: z.boolean().default(true),
  })
  .transform((input, ctx) => {
    const cron = resolveCadence(input, ctx, true);
    if (cron === undefined) return z.NEVER;
    return {
      key: input.key,
      type: input.type,
      cron,
      timezone: input.timezone,
      payload: input.payload,
      enabled: input.enabled,
    };
  });

export type CreateScheduledJobInput = z.infer<typeof createScheduledJobSchema>;

export const updateScheduledJobSchema = z
  .object({
    ...cadenceFields,
    timezone: scheduleTimeZoneSchema.optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
    enabled: z.boolean().optional(),
  })
  .transform((patch, ctx) => {
    const cron = resolveCadence(patch, ctx, false);
    const next: {
      cron?: string;
      timezone?: string;
      payload?: Record<string, unknown>;
      enabled?: boolean;
    } = {};
    if (cron !== undefined) next.cron = cron;
    if (patch.timezone !== undefined) next.timezone = patch.timezone;
    if (patch.payload !== undefined) next.payload = patch.payload;
    if (patch.enabled !== undefined) next.enabled = patch.enabled;

    if (Object.keys(next).length === 0) {
      ctx.addIssue({ code: 'custom', ...invalid('noFieldToChange') });
      return z.NEVER;
    }
    return next;
  });

export type UpdateScheduledJobInput = z.infer<typeof updateScheduledJobSchema>;

export async function listScheduledJobs(db: Database = getDb()): Promise<ScheduledJob[]> {
  return db.select().from(scheduledJobs).orderBy(asc(scheduledJobs.key));
}

/** Tâches à installer dans BullMQ. Le reste doit en être retiré. */
export async function listEnabledScheduledJobs(
  db: Database = getDb(),
): Promise<ScheduledJob[]> {
  return db
    .select()
    .from(scheduledJobs)
    .where(eq(scheduledJobs.enabled, true))
    .orderBy(asc(scheduledJobs.key));
}

export async function getScheduledJob(
  id: string,
  db: Database = getDb(),
): Promise<ScheduledJob | null> {
  const [row] = await db.select().from(scheduledJobs).where(eq(scheduledJobs.id, id));
  return row ?? null;
}

export async function getScheduledJobByKey(
  key: string,
  db: Database = getDb(),
): Promise<ScheduledJob | null> {
  const [row] = await db.select().from(scheduledJobs).where(eq(scheduledJobs.key, key));
  return row ?? null;
}

export async function createScheduledJob(
  input: CreateScheduledJobInput,
  db: Database = getDb(),
): Promise<ScheduledJob> {
  // Sans clé explicite, on prend celle que le type propose : `scan:periodic`,
  // `health:periodic`… La contrainte d'unicité fait le reste.
  const key = input.key ?? SCHEDULED_JOB_TYPES[input.type].defaultKey;

  // Défaut du fuseau : celui que l'opérateur a déjà déclaré dans les paramètres
  // d'instance. Pas `UTC` en dur — ce serait redemander à chacun de convertir
  // mentalement une heure qu'il a pourtant déjà exprimée une fois.
  const timezone = input.timezone ?? (await getAppSettingsValue(db)).timezone;

  const [row] = await db
    .insert(scheduledJobs)
    .values({
      key,
      type: input.type,
      cron: input.cron,
      timezone,
      payload: input.payload,
      enabled: input.enabled,
    })
    .returning();

  if (!row) throw new Error("createScheduledJob : l'insertion n'a rien retourné");
  return row;
}

export async function updateScheduledJob(
  id: string,
  patch: UpdateScheduledJobInput,
  db: Database = getDb(),
): Promise<ScheduledJob | null> {
  const values: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.cron !== undefined) values.cron = patch.cron;
  if (patch.timezone !== undefined) values.timezone = patch.timezone;
  if (patch.payload !== undefined) values.payload = patch.payload;
  if (patch.enabled !== undefined) values.enabled = patch.enabled;

  const [row] = await db
    .update(scheduledJobs)
    .set(values)
    .where(eq(scheduledJobs.id, id))
    .returning();
  return row ?? null;
}

export async function deleteScheduledJob(
  id: string,
  db: Database = getDb(),
): Promise<ScheduledJob | null> {
  const [row] = await db.delete(scheduledJobs).where(eq(scheduledJobs.id, id)).returning();
  return row ?? null;
}

export async function touchScheduledJob(
  id: string,
  at: Date = new Date(),
  db: Database = getDb(),
): Promise<void> {
  await db.update(scheduledJobs).set({ lastRunAt: at }).where(eq(scheduledJobs.id, id));
}

// ─── historique des exécutions ────────────────────────────────────────────────

export async function startScheduledJobRun(
  input: { scheduledJobId: string; manual: boolean },
  db: Database = getDb(),
): Promise<ScheduledJobRun> {
  const [row] = await db
    .insert(scheduledJobRuns)
    .values({
      scheduledJobId: input.scheduledJobId,
      status: 'running',
      manual: input.manual,
      startedAt: new Date(),
    })
    .returning();

  if (!row) throw new Error("startScheduledJobRun : l'insertion n'a rien retourné");
  return row;
}

export async function finishScheduledJobRun(
  id: string,
  outcome: {
    status: 'success' | 'failed' | 'skipped';
    summary?: unknown;
    error?: string | null;
  },
  db: Database = getDb(),
): Promise<void> {
  await db
    .update(scheduledJobRuns)
    .set({
      status: outcome.status,
      summary: outcome.summary ?? null,
      error: outcome.error ?? null,
      finishedAt: new Date(),
    })
    .where(eq(scheduledJobRuns.id, id));
}

export async function listScheduledJobRuns(
  scheduledJobId: string,
  limit = 20,
  db: Database = getDb(),
): Promise<ScheduledJobRun[]> {
  return db
    .select()
    .from(scheduledJobRuns)
    .where(eq(scheduledJobRuns.scheduledJobId, scheduledJobId))
    .orderBy(desc(scheduledJobRuns.startedAt))
    .limit(limit);
}

/** Dernière exécution de chaque tâche, en une requête, pour la liste. */
export async function lastRunsByJob(
  db: Database = getDb(),
): Promise<Map<string, ScheduledJobRun>> {
  const rows = await db
    .select()
    .from(scheduledJobRuns)
    .orderBy(desc(scheduledJobRuns.startedAt))
    .limit(500);

  const map = new Map<string, ScheduledJobRun>();
  for (const row of rows) {
    if (!map.has(row.scheduledJobId)) map.set(row.scheduledJobId, row);
  }
  return map;
}

/** Purge les exécutions au-delà des `keep` plus récentes, toutes tâches confondues. */
export async function pruneScheduledJobRuns(
  scheduledJobId: string,
  keep = 50,
  db: Database = getDb(),
): Promise<number> {
  const rows = await db
    .select({ id: scheduledJobRuns.id })
    .from(scheduledJobRuns)
    .where(eq(scheduledJobRuns.scheduledJobId, scheduledJobId))
    .orderBy(desc(scheduledJobRuns.startedAt))
    .offset(keep);

  let removed = 0;
  for (const row of rows) {
    await db.delete(scheduledJobRuns).where(eq(scheduledJobRuns.id, row.id));
    removed += 1;
  }
  return removed;
}

/** Tâches d'un type donné, pour éviter d'en installer deux qui font la même chose. */
export async function countScheduledJobsOfType(
  type: ScheduledJobType,
  db: Database = getDb(),
): Promise<number> {
  const rows = await db
    .select({ id: scheduledJobs.id })
    .from(scheduledJobs)
    .where(and(eq(scheduledJobs.type, type), eq(scheduledJobs.enabled, true)));
  return rows.length;
}
