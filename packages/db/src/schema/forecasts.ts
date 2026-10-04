import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { ForecastKind, ForecastSeverity, ForecastSubjectType } from '@pupitre/core';
import { applications, targets } from './infra.js';
import { monitors } from './monitors.js';
import { routes } from './proxies.js';

/**
 * The ongoing forecasts: what is going to break, observed by the worker's sweep
 * (`forecast:sweep`).
 *
 * One row per episode, like threshold breaches: opened when the finding appears,
 * kept up to date while it lasts, closed (`resolved_at`) when it disappears. That
 * is what allows warning **once** — at opening — and not at each sweep.
 *
 * The subject is polymorphic (a target, a probe, a route, an application):
 * `subject_type` + `subject_id`, which reads well. And so that **the database**
 * guarantees a forecast does not outlive its subject, one generated column per
 * type, each a foreign key `ON DELETE CASCADE`: deleting a target takes its
 * forecasts in the same transaction, through any path — the API route, or the
 * cascade of an application taking its domains. Postgres computes these
 * columns: no code writes them, they cannot contradict the subject.
 */
export const forecasts = pgTable(
  'forecasts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').$type<ForecastKind>().notNull(),
    subjectType: text('subject_type').$type<ForecastSubjectType>().notNull(),
    subjectId: text('subject_id').notNull(),
    /** The subject's name at the last sweep: the row reads without a join. */
    subjectName: text('subject_name').notNull(),
    severity: text('severity').$type<ForecastSeverity>().notNull(),
    /** When the wall is reached, for the forecasts that have one. */
    etaAt: timestamp('eta_at', { withTimezone: true }),
    /** The finding's figures (rate, medians, days left…). */
    detail: jsonb('detail').$type<Record<string, number | string | null>>().notNull().default({}),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    targetId: uuid('target_id')
      .generatedAlwaysAs(sql`case when subject_type = 'target' then subject_id::uuid end`)
      .references(() => targets.id, { onDelete: 'cascade' }),
    monitorId: uuid('monitor_id')
      .generatedAlwaysAs(sql`case when subject_type = 'monitor' then subject_id::uuid end`)
      .references(() => monitors.id, { onDelete: 'cascade' }),
    routeId: uuid('route_id')
      .generatedAlwaysAs(sql`case when subject_type = 'route' then subject_id::uuid end`)
      .references(() => routes.id, { onDelete: 'cascade' }),
    applicationId: uuid('application_id')
      .generatedAlwaysAs(sql`case when subject_type = 'application' then subject_id::uuid end`)
      .references(() => applications.id, { onDelete: 'cascade' }),
  },
  (t) => [
    uniqueIndex('forecasts_open_idx')
      .on(t.kind, t.subjectType, t.subjectId)
      .where(sql`${t.resolvedAt} is null`),
    index('forecasts_subject_idx').on(t.subjectType, t.subjectId),
  ],
);

export type ForecastRow = typeof forecasts.$inferSelect;
