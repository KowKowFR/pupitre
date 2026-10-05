import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { targets } from './infra.js';

/**
 * Server monitoring's memory.
 *
 * ── The flaw being fixed ────────────────────────────────────────────────────
 * The host reading (`target:metrics`) was triggered by the screen and died with
 * the job's response. One saw "disk: 89%" without knowing whether it was 11%
 * last week. A reading is not monitoring: it lacks the past, and it lacks the
 * threshold that says when that past becomes a problem.
 *
 * ── Why it is not a reinvention ─────────────────────────────────────────────
 * The shape is **copied from site monitoring** (`schema/monitors.ts`),
 * deliberately, because it already settled the same questions:
 *
 *   `monitor_checks`     → `target_metric_samples`   the raw time series,
 *                                                    30 days, purged in batches
 *   `monitor_incidents`  → `target_metric_breaches`  the episode, one row, with
 *                                                    the partial unique index
 *                                                    that guarantees ONE alert
 *   `monitors.*_threshold` → `target_metric_thresholds`  the thresholds, adjustable
 *
 * Two different models for two time series of the same panel would have cost
 * two retentions to remember, two purges to watch and two ways of reading a
 * timeline.
 *
 * ── The only accepted divergence: columns, not JSONB ────────────────────────
 * `monitor_checks.metrics` is JSONB because a TLS probe and an HTTP probe do not
 * measure the same things — the types catalog is open. Here the dimensions are
 * closed: a Linux machine has a load, a memory, a disk and an uptime, and that
 * depends neither on the runtime nor on anything else (it is already the
 * argument of `packages/core/src/host-metrics.ts`). Typed columns also let
 * Postgres aggregate — `max(disk_use_percent)` over a window — what a JSONB
 * would make unreadable and unindexable.
 */

/**
 * The time series of host readings.
 *
 * It grows endlessly by nature. Default interval: one reading every 5 minutes
 * per machine (`HOST_SAMPLE_INTERVAL_SECONDS`), retention 30 days
 * (`HOST_SAMPLE_RETENTION_DAYS`, which equals the site probes' and says so).
 * That is ~8,600 rows per machine per month: three times less than a site probe
 * every minute, for data that moves three times slower.
 *
 * **An unreachable reading is recorded too**, with its reason and without
 * metrics. It is information: a gap in the timeline does not say whether the
 * machine was off or the panel was asleep.
 */
export const targetMetricSamples = pgTable(
  'target_metric_samples',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'cascade' }),
    sampledAt: timestamp('sampled_at', { withTimezone: true }).notNull().defaultNow(),

    /** Who paid for this reading: the sweep, or someone who clicked "Read now". */
    source: text('source').notNull().default('sweep'),

    reachable: boolean('reachable').notNull(),
    /** Establishing the SSH session. `null` when it did not succeed. */
    latencyMs: integer('latency_ms'),
    /** Filled in only when the machine did not answer. */
    error: text('error'),

    /**
     * The three load averages, and not only the one-minute one. It is what makes a
     * 5-minute interval honest: `load15` covers the interval between two readings,
     * where `load1` alone would leave four-minute spikes perfectly invisible.
     */
    loadOne: real('load_one'),
    loadFive: real('load_five'),
    loadFifteen: real('load_fifteen'),
    cores: integer('cores'),
    /**
     * `load1 / cores`, **as a percentage of capacity** (100 = one full core per
     * core). The percentage is not cosmetic: it puts the load in the same unit as
     * memory and disk, which allows **a single kind of threshold** and a single
     * threshold column for the three metrics. `null` when `nproc` is missing —
     * never 0, never 1 core assumed.
     */
    loadPercent: real('load_percent'),

    /** Kibibytes, as `/proc/meminfo` gives them. */
    memoryTotalKb: bigint('memory_total_kb', { mode: 'number' }),
    memoryUsedKb: bigint('memory_used_kb', { mode: 'number' }),
    memoryPercent: real('memory_percent'),

    /** The partition carrying the deployments, not necessarily `/`. */
    diskPath: text('disk_path'),
    diskSizeKb: bigint('disk_size_kb', { mode: 'number' }),
    diskUsedKb: bigint('disk_used_kb', { mode: 'number' }),
    diskPercent: real('disk_percent'),

    uptimeSeconds: bigint('uptime_seconds', { mode: 'number' }),
  },
  (t) => [
    // The screen's only two queries:
    //   "a machine's 24 h / 7 d window"  → WHERE target_id = … AND sampled_at >= …
    //   "the last known reading"         → ORDER BY sampled_at DESC LIMIT 1
    // A composite index serves both.
    index('target_metric_samples_target_time_idx').on(t.targetId, t.sampledAt.desc()),
    // The purge sweeps all machines together: it needs the time alone, otherwise it
    // reads the whole table every hour.
    index('target_metric_samples_sampled_at_idx').on(t.sampledAt),
  ],
);

/**
 * The thresholds. **A global default, overridable per machine.**
 *
 * Why both, and not one of the two:
 *
 *   — a global-only threshold does not survive the real fleet. A build server
 *     lives at 95% disk by construction; alerting it every day teaches ignoring
 *     the alert;
 *   — a per-machine-only threshold forces setting ten machines to get a behavior
 *     that should be the out-of-the-box one.
 *
 * `target_id is null` **is** the global row: it is not a soft convention, two
 * partial unique indexes enforce it. Without them, `unique(target_id, metric)`
 * would let through as many global rows as one likes — two `NULL`s are never
 * equal in SQL.
 *
 * And a third layer, in code: when no row exists, the catalog
 * (`HOST_METRIC_CATALOG`) gives the value. The table therefore never needs to be
 * pre-filled, and a new instance alerts anyway.
 */
export const targetMetricThresholds = pgTable(
  'target_metric_thresholds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** `null` = the instance's default, the one that applies to any machine. */
    targetId: uuid('target_id').references(() => targets.id, { onDelete: 'cascade' }),
    /**
     * Metric key — `disk`, `memory`, `load`. `text` and not an enum, for the reason
     * that made `text` the choice for `monitors.type`: an enum would add a migration
     * to the list of what must be done to monitor one more dimension. The
     * vocabulary stays closed, in the catalog, and Zod enforces it at each write.
     */
    metric: text('metric').notNull(),

    /** Beyond which (strictly) the metric is in breach. As a percentage. */
    limitPercent: real('limit_percent').notNull(),
    /**
     * Consecutive readings above the threshold before opening the episode, and
     * consecutive readings below before closing it. The same vocabulary as
     * `monitors.failure_threshold` / `recovery_threshold`, and the same reason: a
     * bounce must produce neither episode nor message.
     */
    breachSamples: integer('breach_samples').notNull().default(1),
    clearSamples: integer('clear_samples').notNull().default(2),
    /** A disabled threshold no longer alerts, but the history keeps being written. */
    enabled: boolean('enabled').notNull().default(true),

    updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('target_metric_thresholds_target_idx')
      .on(t.targetId, t.metric)
      .where(sql`${t.targetId} is not null`),
    uniqueIndex('target_metric_thresholds_global_idx')
      .on(t.metric)
      .where(sql`${t.targetId} is null`),
    // Cap at 1000 and not 100: the per-core load is expressed as a percentage of
    // capacity and legitimately exceeds 100% on an overloaded machine.
    check(
      'target_metric_thresholds_limit_check',
      sql`${t.limitPercent} > 0 and ${t.limitPercent} <= 1000`,
    ),
    check(
      'target_metric_thresholds_samples_check',
      sql`${t.breachSamples} between 1 and 10 and ${t.clearSamples} between 1 and 10`,
    ),
  ],
);

/**
 * The breaches. **A table, not a derivation at read time.**
 *
 * The reasoning is `monitor_incidents`'s, and it holds word for word:
 *
 *  1. the alert must go out **only once**, which requires a durable trace of "I
 *     already warned" — it is this row. A machine whose disk stays at 92% for
 *     three days produces **one** episode, hence **one** audit entry, and not
 *     one per reading;
 *  2. the threshold is adjustable: deriving the episodes at read time would make
 *     breaches appear retroactively in a timeline a human already read.
 *     `limit_percent` is therefore **copied into the row** at opening: the
 *     episode says under which threshold it was decided, even if the threshold
 *     moved since;
 *  3. the cost: deriving means replaying the rule over the whole series at each
 *     display, on the table made to grow.
 *
 * The **partial** unique index on `(target_id, metric) where resolved_at is null`
 * is the guarantee that a machine never has two open breaches on the same
 * metric — including if the sweep and a manual "Read now" conclude at the same
 * time. Like port collision avoidance: a constraint, not an `if`.
 */
export const targetMetricBreaches = pgTable(
  'target_metric_breaches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'cascade' }),
    metric: text('metric').notNull(),

    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),

    /** The threshold **as it was** at the crossing. Never read back from the table. */
    limitPercent: real('limit_percent').notNull(),
    /** The value that tipped it over. */
    openedValue: real('opened_value').notNull(),
    /** The worst value reached during the episode — what one wants to read afterwards. */
    peakValue: real('peak_value').notNull(),
    lastValue: real('last_value').notNull(),
    /** Readings observed since opening. Says the duration in number of measurements. */
    samples: integer('samples').notNull().default(1),
  },
  (t) => [
    uniqueIndex('target_metric_breaches_open_idx')
      .on(t.targetId, t.metric)
      .where(sql`${t.resolvedAt} is null`),
    index('target_metric_breaches_target_started_idx').on(t.targetId, t.startedAt.desc()),
  ],
);
