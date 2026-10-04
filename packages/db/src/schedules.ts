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
 * Persistence of scheduled tasks.
 *
 * The database is the **source of truth**; BullMQ is only its execution mirror.
 * The worker reconciles one onto the other at each startup: a task disabled here
 * disappears from Redis, a task present here and absent from Redis is recreated
 * there. That is what lets a worker restart — or a `docker compose down` — lose
 * nothing.
 */

export type ScheduledJob = typeof scheduledJobs.$inferSelect;
export type ScheduledJobRun = typeof scheduledJobRuns.$inferSelect;

/** A BullMQ key: readable, stable, usable in a URL and in Redis. */
const keySchema = z
  .string()
  .trim()
  .min(3)
  .max(120)
  .regex(/^[a-z0-9]+(?:[:._-][a-z0-9]+)*$/, 'clé en minuscules, séparateurs `: . _ -`');

/**
 * Interval: a cron expression, or a simplified periodicity.
 *
 * The screen's simplified mode is an **input convenience**; the server does not
 * trust the client for all that. `schedule` is converted here by `toCron()` then
 * validated by `cronSchema`, exactly like a hand-written expression: there is
 * only one validation path, and one persisted format.
 *
 * Providing both at once is refused — two intervals in the same request body,
 * one would have to be chosen, and choosing in the caller's place is the best
 * way to schedule something other than what was asked.
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
    // The conversion is supposed to produce a valid expression; we validate it again
    // anyway, so that `cronSchema` stays the only way in.
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
     * Absent = the instance settings' time zone, resolved by `createScheduledJob()`.
     * No Zod default here: the default requires a database read, and a schema reads
     * nothing.
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

/** Tasks to install in BullMQ. The rest must be removed from it. */
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
  // Without an explicit key, we take the one the type offers: `scan:periodic`,
  // `health:periodic`… The uniqueness constraint does the rest.
  const key = input.key ?? SCHEDULED_JOB_TYPES[input.type].defaultKey;

  // Time zone default: the one the operator already declared in the instance
  // settings. Not a hard-coded `UTC` — that would ask everyone again to mentally
  // convert a time they already expressed once.
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

  if (!row) throw new Error("createScheduledJob: the insert returned nothing");
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

// ─── run history ──────────────────────────────────────────────────────────────

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

  if (!row) throw new Error("startScheduledJobRun: the insert returned nothing");
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

/** Each task's last run, in one query, for the list. */
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

/** Purges the runs beyond the `keep` most recent, all tasks together. */
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

/** Tasks of a given type, to avoid installing two that do the same thing. */
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
