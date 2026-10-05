import type { CaptureKind, CheckMetrics, MonitorType } from '@pupitre/core';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea } from './columns.js';
import { healthStatusEnum } from '../enums.js';
import { users } from './auth.js';
import { applications } from './infra.js';

/**
 * Site monitoring — probed from the worker, toward the public target.
 *
 * Not to be confused with `deployments.health_status`, which the
 * `health:periodic` task fills by querying the target machine over SSH. This one
 * comes from outside: it is the only way to see a firewall closed again, a
 * broken proxy, an expired certificate or a dead DNS.
 *
 * ── Why the table does not describe an HTTP request ─────────────────────────
 * Six kinds of monitoring are targeted (HTTP, keyword, TLS, DNS, domain expiry,
 * content fingerprint). They are not six features but one abstraction and six
 * implementations. The table therefore carries **what is common** — type,
 * interval, state, thresholds, attachment — and the type-specific configuration
 * lives in `config`, as JSONB, validated by that type's Zod schema
 * (`packages/core/src/monitors/catalog.ts`). Adding a type does not touch this
 * table.
 */
export const monitors = pgTable(
  'monitors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /**
     * Probe type. Deliberately `text` and not a Postgres enum: an enum would add a
     * migration to the list of what must be done to add a type, and that is
     * precisely the surgery we want to avoid. The vocabulary stays closed — it lives
     * in `MONITOR_TYPES` and Zod enforces it at each input. An unknown value in the
     * database (code rolled back) pauses the probe with its reason, never crashes the
     * sweep.
     */
    type: text('type').$type<MonitorType>().notNull().default('http'),
    /** Type-specific configuration, validated by that type's Zod schema. */
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),

    intervalSeconds: integer('interval_seconds').notNull().default(60),
    /**
     * Confirmation threshold. A bounce — a measurement that fails then passes again
     * — must produce neither an incident nor a message: it takes
     * `failure_threshold` consecutive failures to open, `recovery_threshold`
     * successes to close.
     */
    failureThreshold: integer('failure_threshold').notNull().default(3),
    recoveryThreshold: integer('recovery_threshold').notNull().default(2),
    enabled: boolean('enabled').notNull().default(true),
    /** Filled in when the probe was paused by the panel, not by a human. */
    pausedReason: text('paused_reason'),
    /**
     * Attachment to an application deployed by the panel. `null` = a free probe, on
     * a site it did not deploy. The target stays copied in `config`: a probe must
     * outlive the version that inspired it.
     */
    applicationId: uuid('application_id').references(() => applications.id, {
      onDelete: 'cascade',
    }),
    /**
     * The alert webhook's URL, encrypted with AES-256-GCM under `MASTER_KEY` — the
     * same treatment as SSH credentials. A Slack or Discord webhook URL *is* the
     * secret: whoever holds it posts in the channel. Never returned by the API,
     * never logged.
     */
    webhookUrlEncrypted: text('webhook_url_encrypted'),

    /** **Confirmed** state. Only moves at transitions, never at the first failure. */
    status: healthStatusEnum('status').notNull().default('unknown'),
    /** Last raw verdict, confirmed or not. It is what says "1 failure out of 3". */
    lastOutcome: healthStatusEnum('last_outcome'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    consecutiveSuccesses: integer('consecutive_successes').notNull().default(0),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    lastLatencyMs: integer('last_latency_ms'),
    lastDetail: text('last_detail'),
    /**
     * Measurements of the last reading. As JSONB, and not as columns: an HTTP probe
     * returns a latency and a code, a TLS probe days left and an issuer. The catalog
     * tells the screen how to show each key.
     */
    lastMetrics: jsonb('last_metrics').$type<CheckMetrics>(),
    /**
     * Due date of the next measurement. It is the column the sweep queries, and
     * moves **before** probing: a slow probe is not picked up again by the next
     * sweep.
     */
    nextCheckAt: timestamp('next_check_at', { withTimezone: true }).notNull().defaultNow(),

    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The sweep's query, and the only one that runs in a loop: "the active probes
    // whose due date has passed". Partial index: a paused probe has no reason to
    // take up the working index.
    index('monitors_due_idx').on(t.nextCheckAt).where(sql`${t.enabled}`),
    index('monitors_application_id_idx').on(t.applicationId),
    // **Absolute** bounds, all types together. Each type's own minimum interval
    // (30 s for HTTP, 1 h for TLS) lives in the catalog: it is knowledge of the
    // type, not of the table, and it would change with it.
    check(
      'monitors_interval_check',
      sql`${t.intervalSeconds} >= 30 and ${t.intervalSeconds} <= 2592000`,
    ),
    check(
      'monitors_threshold_check',
      sql`${t.failureThreshold} between 1 and 10 and ${t.recoveryThreshold} between 1 and 10`,
    ),
  ],
);

/**
 * The time series.
 *
 * It grows endlessly by nature: a probe every minute writes 43,200 rows a month.
 * Its retention is **30 days** (`MONITOR_CHECK_RETENTION_DAYS`), applied by the
 * sweep — see the constant's comment for the reasoning. A table that swells
 * silently is a flaw.
 */
export const monitorChecks = pgTable(
  'monitor_checks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    monitorId: uuid('monitor_id')
      .notNull()
      .references(() => monitors.id, { onDelete: 'cascade' }),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
    /** Never `unknown`: a measurement has always decided. */
    outcome: healthStatusEnum('outcome').notNull(),
    /** `null` when nothing answered — there is then no duration to measure. */
    latencyMs: integer('latency_ms'),
    detail: text('detail'),
    /** The type's measurements: HTTP code and redirects, or days left and issuer. */
    metrics: jsonb('metrics').$type<CheckMetrics>().notNull().default({}),
  },
  (t) => [
    // The only two queries the screen really makes:
    //   "a probe's last N results"   → ORDER BY checked_at DESC LIMIT n
    //   "the rate over 24 h / 7 d"   → WHERE checked_at >= now() - …
    // A single composite index serves both.
    index('monitor_checks_monitor_time_idx').on(t.monitorId, t.checkedAt.desc()),
    // The purge sweeps all probes together: it needs the time alone, otherwise it
    // reads the whole table every hour.
    index('monitor_checks_checked_at_idx').on(t.checkedAt),
  ],
);

/**
 * The incidents. **A table, not a derivation at read time.**
 *
 * Three reasons, in order of importance:
 *
 *  1. The alert must go out **only once**. That requires a durable trace of "I
 *     already warned", and that trace is the incident row. A computation at read
 *     time would not know whether the message went out.
 *  2. The confirmation threshold is adjustable **per probe**. Deriving the
 *     incidents at read time would make lowering the threshold rewrite the past:
 *     incidents would appear retroactively in a timeline a human had already
 *     read. An incident is a decision taken at an instant, with that instant's
 *     settings; it must be immutable.
 *  3. The cost. Deriving means replaying the state machine over the whole series
 *     at each display — on precisely the table designed to grow.
 *
 * The **partial** unique index on `(monitor_id) where resolved_at is null` is the
 * guarantee that a probe never has two open incidents. Like port collision
 * avoidance: a constraint, not an `if`.
 */
export const monitorIncidents = pgTable(
  'monitor_incidents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    monitorId: uuid('monitor_id')
      .notNull()
      .references(() => monitors.id, { onDelete: 'cascade' }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    /** The outage's nature at opening: `unhealthy` or `unreachable`. */
    cause: healthStatusEnum('cause').notNull(),
    detail: text('detail'),
    metrics: jsonb('metrics').$type<CheckMetrics>().notNull().default({}),
    /** How many consecutive failures confirmed the opening. */
    failureCount: integer('failure_count').notNull().default(1),
    alertSentAt: timestamp('alert_sent_at', { withTimezone: true }),
    alertError: text('alert_error'),
    resolveAlertSentAt: timestamp('resolve_alert_sent_at', { withTimezone: true }),
    resolveAlertError: text('resolve_alert_error'),
  },
  (t) => [
    uniqueIndex('monitor_incidents_open_idx')
      .on(t.monitorId)
      .where(sql`${t.resolvedAt} is null`),
    index('monitor_incidents_monitor_started_idx').on(t.monitorId, t.startedAt.desc()),
  ],
);

/**
 * **What the probe saw.**
 *
 * An image of the page, taken when an incident opens or closes, plus a reference
 * image taken while all was well. The reasoning — why three moments and not one,
 * why JPEG, why a hard size cap — lives in
 * `packages/core/src/monitors/capture.ts`, with the rest of the vocabulary.
 * Here: where the bytes live, and how the table stays bounded.
 *
 * ── Why the bytes are in Postgres and not in a volume ───────────────────────
 * A volume would be lighter for the database. It would, however, add a **second
 * thing to back up**, and this project has *no* backup story today: adding a
 * second medium not to forget when one is already not backed up is choosing to
 * lose the images. In the database, the capture follows the incident wherever it
 * goes — the `pg_dump` someone will end up writing, the copy of the database to
 * a test workstation, a probe's cascading deletion. And there is no volume to
 * mount in two containers (the worker writes, the panel serves), hence no shared
 * path to keep in agreement.
 *
 * The cost is real, and it is **bounded by construction**:
 *   — a single live reference per probe (the partial unique index below);
 *   — at most two images per incident;
 *   — the bytes purged at 90 days, the row kept.
 * Fifty probes and a hundred incidents in a year make a few tens of megabytes —
 * to compare with the dump of a database that already carries the whole
 * deployment history.
 *
 * ⚠ `image` must **never** go out in a `select *`: the screens list dozens of
 * captures and only need the metadata. Reads go through
 * `packages/db/src/captures.ts`, which names its columns and only loads the
 * bytes for the route that serves the image.
 */
export const monitorCaptures = pgTable(
  'monitor_captures',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    monitorId: uuid('monitor_id')
      .notNull()
      .references(() => monitors.id, { onDelete: 'cascade' }),
    /**
     * `null` = **live** reference, the one that will serve as "before" for the next
     * incident. Filled in = image attached to that incident, kept with it. That is
     * what "pins" the reference at the instant the outage starts: the before/after
     * comparison stays true even when a fresher reference is taken afterwards.
     */
    incidentId: uuid('incident_id').references(() => monitorIncidents.id, {
      onDelete: 'cascade',
    }),
    /** `reference` | `incident_open` | `incident_resolved`. */
    kind: text('kind').$type<CaptureKind>().notNull(),
    takenAt: timestamp('taken_at', { withTimezone: true }).notNull().defaultNow(),

    /** The requested URL, and the one really rendered after redirects. */
    url: text('url').notNull(),
    finalUrl: text('final_url'),
    /** Code of the main response, when the browser saw it go by. */
    httpStatus: integer('http_status'),
    pageTitle: text('page_title'),

    width: integer('width').notNull(),
    height: integer('height').notNull(),
    format: text('format').notNull().default('jpeg'),
    /** Size in bytes. Kept after the purge: it documents what was. */
    bytes: integer('bytes').notNull(),
    /** The page was taller than the render cap. Said, never hidden. */
    truncated: boolean('truncated').notNull().default(false),
    /** The capture's duration. A page taking 20 s to render is information. */
    elapsedMs: integer('elapsed_ms'),

    /**
     * The bytes. `null` after the retention purge — the row stays: a timeline that
     * says what it lost is better than a timeline silently truncated.
     */
    image: bytea('image'),
    purgedAt: timestamp('purged_at', { withTimezone: true }),
  },
  (t) => [
    /**
     * **A single live reference per probe.** A constraint, not an `if` — the same
     * discipline as port collision avoidance and the single open incident. It is
     * what bounds the table: without it, a reference every six hours would make a
     * hundred and twenty images per probe per month.
     *
     * Pinning the reference to an incident (`incident_id` filled in) takes it out of
     * the index, which frees the place for the next one. Rotation is therefore an
     * effect of the constraint, not a cleanup task.
     */
    uniqueIndex('monitor_captures_live_reference_idx')
      .on(t.monitorId)
      .where(sql`${t.kind} = 'reference' and ${t.incidentId} is null`),
    // What the detail screen asks for: an incident's images.
    index('monitor_captures_incident_idx').on(t.incidentId),
    index('monitor_captures_monitor_taken_idx').on(t.monitorId, t.takenAt.desc()),
    // The purge sweeps all probes together: it needs the time alone, and only the
    // rows that still carry bytes.
    index('monitor_captures_taken_at_idx')
      .on(t.takenAt)
      .where(sql`${t.image} is not null`),
    check(
      'monitor_captures_kind_check',
      sql`${t.kind} in ('reference', 'incident_open', 'incident_resolved')`,
    ),
    /**
     * An incident image without an incident makes no sense. The pair is constrained
     * here rather than in the code that inserts.
     */
    check(
      'monitor_captures_incident_check',
      sql`(${t.kind} = 'reference') or (${t.incidentId} is not null)`,
    ),
  ],
);
