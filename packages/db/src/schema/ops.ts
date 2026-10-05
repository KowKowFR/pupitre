import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { scheduledJobTypeEnum, stepStatusEnum } from '../enums.js';
import { apiTokens } from './api-tokens.js';
import { users } from './auth.js';

/**
 * Audit log. Fed **exclusively** by `logAudit()`.
 * No scattered insert in the handlers.
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** `null` for system actions (worker, scheduler). */
    actorId: text('actor_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    ip: text('ip'),
    /**
     * The browser or the client that sent the request, as it announces itself.
     * `null` for a worker action, which has no request behind it.
     */
    userAgent: text('user_agent'),
    /**
     * The API token through which the actor acted, or `null` for a browser session
     * (and for the worker). Filled in by the request context, like the browser: no
     * call to `logAudit()` has to think about it.
     */
    apiTokenId: uuid('api_token_id').references(() => apiTokens.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_logs_actor_id_idx').on(t.actorId),
    index('audit_logs_created_at_idx').on(t.createdAt),
    index('audit_logs_resource_idx').on(t.resourceType, t.resourceId),
  ],
);

/**
 * Database mirror of the BullMQ repeatable jobs.
 * No Linux cron: BullMQ is the only scheduling source.
 */
export const scheduledJobs = pgTable(
  'scheduled_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** BullMQ key of the repeatable job. */
    key: text('key').notNull().unique(),
    type: scheduledJobTypeEnum('type').notNull(),
    cron: text('cron').notNull(),
    /**
     * IANA time zone in which the cron pattern is interpreted, passed to BullMQ as
     * `{ pattern, tz }`. The column default is `UTC` — not the instance's time zone:
     * it only exists for what already existed, see migration `0009`.
     */
    timezone: text('timezone').notNull().default('UTC'),
    payload: jsonb('payload').notNull().default({}),
    enabled: boolean('enabled').notNull().default(true),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('scheduled_jobs_enabled_idx').on(t.enabled)],
);

/**
 * History of scheduled runs.
 *
 * A dedicated table and not `audit_logs`: they are not the same questions. The
 * audit log answers "who did what", it is append-only and read by a human
 * investigating. This table answers "did the 4 a.m. scan run, for how long, and
 * what did it find" — it is framed by a foreign key, purged with its task, and
 * shown next to the cron. Both exist: each run also goes through `logAudit()`.
 */
export const scheduledJobRuns = pgTable(
  'scheduled_job_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scheduledJobId: uuid('scheduled_job_id')
      .notNull()
      .references(() => scheduledJobs.id, { onDelete: 'cascade' }),
    /** Reuses the deployment steps' scale: same states, same vocabulary. */
    status: stepStatusEnum('status').notNull().default('running'),
    /** Triggered by hand from the UI, or by the BullMQ scheduler. */
    manual: boolean('manual').notNull().default(false),
    /** What the task did, in a shape specific to its type. */
    summary: jsonb('summary'),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('scheduled_job_runs_job_id_idx').on(t.scheduledJobId),
    index('scheduled_job_runs_started_at_idx').on(t.startedAt),
  ],
);
