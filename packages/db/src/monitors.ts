import {
  MONITOR_FAILURE_THRESHOLD_DEFAULT,
  MONITOR_INTERVAL_CEILING_SECONDS,
  MONITOR_INTERVAL_FLOOR_SECONDS,
  MONITOR_PAUSE_ORPHANED,
  MONITOR_PRUNE_BATCH,
  MONITOR_RECOVERY_THRESHOLD_DEFAULT,
  MONITOR_THRESHOLD_MAX,
  MONITOR_THRESHOLD_MIN,
  checkMonitorTargetLiterals,
  decrypt,
  describeMonitorTarget,
  encrypt,
  formatCadence,
  isMonitorType,
  parseCidrList,
  type Cidr,
  monitorOutcomeSchema,
  monitorTargetLink,
  monitorTypeDefinition,
  monitorTypeSchema,
  monitorUrlSchema,
  nextMonitorState,
  uptimeRatio,
  type CheckMetrics,
  type CheckResult,
  type MonitorTransition,
  type MonitorType,
  type SsrfRefusal,
  type UiLanguage,
  type UptimeWindow,
  invalid,
} from '@pupitre/core';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type Database } from './client.js';
import { applications } from './schema/infra.js';
import { deployments } from './schema/deployments.js';
import {
  monitorCaptures,
  monitorChecks,
  monitorIncidents,
  monitors,
} from './schema/monitors.js';

/**
 * Persistence of site monitoring.
 *
 * Everything that decides lives in `@pupitre/core`: the state machine
 * (`nextMonitorState`) and the per-type validation (the catalog). This module
 * writes. The only intelligence left here is transactional: a measurement,
 * advancing the state and opening — or closing — an incident must land
 * together, or not at all.
 *
 * No `if (type === 'http')` anywhere: the type is data, its configuration schema
 * and its minimum interval come from the catalog.
 */

export type Monitor = typeof monitors.$inferSelect;
export type MonitorCheck = typeof monitorChecks.$inferSelect;
export type MonitorIncident = typeof monitorIncidents.$inferSelect;

/**
 * Why a probe configuration is refused, **as data**.
 *
 * ── Why not a sentence, and not a dictionary here ───────────────────────────
 * This refusal is shown: it comes up as a 422 in the probe form's banner. It
 * should therefore speak the instance's language — but `@pupitre/db` knows none,
 * and has no reason to become a translations repository: this layer writes to
 * the database, it talks to nobody.
 *
 * The refusal therefore travels in separate pieces — the type, the field, the
 * bound, the requested value — and it is the HTTP route, which has the language
 * at hand, that makes a sentence of it from `i18n/messages/monitors`. The same
 * split as `HttpError`: the data at the bottom, the words at the top.
 *
 * `Error.message` is filled in in English, the language of the code: it is what
 * `Error.stack` shows and what Pino logs.
 */
export type MonitorConfigReason =
  /**
   * The configuration does not pass the type's schema. `issue` comes from Zod, in
   * French; `params` allows saying it again (`issueMessage()`).
   */
  | { kind: 'schema'; type: MonitorType; path: string; issue: string; params?: unknown }
  /** A literal target no allow list opens. */
  | { kind: 'target'; refusal: SsrfRefusal }
  /** An interval under the floor this type declares. */
  | { kind: 'interval'; type: MonitorType; minSeconds: number; askedSeconds: number };

/** An interval refused by the type, or an invalid configuration: 422, not 500. */
export class MonitorConfigError extends Error {
  override readonly name = 'MonitorConfigError';
  constructor(
    message: string,
    readonly field: string,
    readonly reason: MonitorConfigReason,
  ) {
    super(message);
  }
}

// ─── validation ───────────────────────────────────────────────────────────────

/**
 * The internal ranges this deployment allows itself to monitor.
 *
 * Read here and not received as a parameter: `resolveConfig()` is called by the
 * panel as by any caller of the persistence layer, and the list is a deployment
 * fact, not a caller's choice. Cached because it does not change without a
 * restart — it comes from the environment, like `MASTER_KEY`.
 */
let cachedCidrs: readonly Cidr[] | null = null;
function allowedCidrs(): readonly Cidr[] {
  cachedCidrs ??= parseCidrList(process.env.MONITOR_ALLOWED_CIDRS);
  return cachedCidrs;
}

const intervalSchema = z
  .number()
  .int()
  .min(MONITOR_INTERVAL_FLOOR_SECONDS)
  .max(MONITOR_INTERVAL_CEILING_SECONDS);

const thresholdSchema = z.number().int().min(MONITOR_THRESHOLD_MIN).max(MONITOR_THRESHOLD_MAX);

/**
 * The common body. `config` stays `unknown` here: it is validated by the type's
 * schema, once the type is known — `resolveConfig()` handles it, and it is the
 * only place where that happens.
 */
export const createMonitorSchema = z.object({
  name: z.string().trim().min(1).max(120),
  type: monitorTypeSchema.default('http'),
  config: z.unknown().default({}),
  /** Absent = the type's default interval. */
  intervalSeconds: intervalSchema.optional(),
  failureThreshold: thresholdSchema.default(MONITOR_FAILURE_THRESHOLD_DEFAULT),
  recoveryThreshold: thresholdSchema.default(MONITOR_RECOVERY_THRESHOLD_DEFAULT),
  enabled: z.boolean().default(true),
  applicationId: z.string().uuid().nullable().default(null),
  /** `null` removes the webhook. Absent = leave it alone. */
  webhookUrl: monitorUrlSchema.nullable().optional(),
});

export type CreateMonitorInput = z.infer<typeof createMonitorSchema>;

export const updateMonitorSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    config: z.unknown().optional(),
    intervalSeconds: intervalSchema.optional(),
    failureThreshold: thresholdSchema.optional(),
    recoveryThreshold: thresholdSchema.optional(),
    enabled: z.boolean().optional(),
    applicationId: z.string().uuid().nullable().optional(),
    webhookUrl: monitorUrlSchema.nullable().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, invalid('noFieldToChange'));

export type UpdateMonitorInput = z.infer<typeof updateMonitorSchema>;

/**
 * Validates a configuration against **its** type's schema, and enforces the
 * minimum interval that type declares.
 *
 * The minimum interval is per type because it is a property of the type: what it
 * costs at the other end, and how fast what it observes can change. An HTTP probe
 * every minute is reasonable; querying a domain registry every minute would make
 * the panel a nuisance.
 */
export function resolveConfig(
  type: MonitorType,
  rawConfig: unknown,
  intervalSeconds: number | undefined,
): { config: Record<string, unknown>; intervalSeconds: number } {
  // The schema in the source language: its complaints are found again by their
  // French sentence on the screen (`issueMessage()`). The thrown message, for the
  // logs, names the type in English.
  const definition = monitorTypeDefinition(type, 'fr');
  const label = monitorTypeDefinition(type, 'en').label;

  const parsed = definition.schema.safeParse(rawConfig ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.join('.') ?? 'config';
    const issue = first?.message ?? 'value refused';
    throw new MonitorConfigError(
      `invalid "${label}" probe configuration — ${path}: ${issue}`,
      `config.${path}`,
      {
        kind: 'schema',
        type,
        path,
        issue,
        ...(first && 'params' in first && first.params ? { params: first.params } : {}),
      },
    );
  }

  // SSRF guard, second layer: the schema refuses what no list unlocks (link-local,
  // hence the metadata services), but it is pure — it cannot read
  // `MONITOR_ALLOWED_CIDRS`, since it is also evaluated in the browser. It is here,
  // on the server side, that loopback and unlisted private ranges are refused,
  // **at creation**, rather than at the first sweep. `checkMonitorTargetLiterals`
  // knows no type: it reads the fields marked `kind: 'host' | 'url'` in the
  // catalog.
  const target = checkMonitorTargetLiterals(type, parsed.data, allowedCidrs());
  if (!target.allowed) {
    throw new MonitorConfigError(target.reason, `config.${target.field}`, {
      kind: 'target',
      refusal: target.refusal,
    });
  }

  const interval = intervalSeconds ?? definition.defaultIntervalSeconds;
  if (interval < definition.minIntervalSeconds) {
    throw new MonitorConfigError(
      `a "${label}" probe does not run more often than ` +
        `${formatCadence(definition.minIntervalSeconds, 'en')} — ${formatCadence(interval, 'en')} asked`,
      'intervalSeconds',
      {
        kind: 'interval',
        type,
        minSeconds: definition.minIntervalSeconds,
        askedSeconds: interval,
      },
    );
  }

  return { config: parsed.data as Record<string, unknown>, intervalSeconds: interval };
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export async function createMonitor(
  input: CreateMonitorInput,
  createdBy: string | null,
  db: Database = getDb(),
): Promise<Monitor> {
  const resolved = resolveConfig(input.type, input.config, input.intervalSeconds);

  const [row] = await db
    .insert(monitors)
    .values({
      name: input.name,
      type: input.type,
      config: resolved.config,
      intervalSeconds: resolved.intervalSeconds,
      failureThreshold: input.failureThreshold,
      recoveryThreshold: input.recoveryThreshold,
      enabled: input.enabled,
      applicationId: input.applicationId,
      webhookUrlEncrypted: input.webhookUrl ? encrypt(input.webhookUrl) : null,
      createdBy,
      // A new probe is due right away: whoever just created it does not wait a whole
      // interval to know whether its target answers.
      nextCheckAt: new Date(),
    })
    .returning();
  if (!row) throw new Error('probe insert returned nothing');
  return row;
}

export async function updateMonitor(
  id: string,
  patch: UpdateMonitorInput,
  db: Database = getDb(),
): Promise<Monitor | null> {
  const current = await getMonitor(id, db);
  if (!current) return null;

  // The type cannot be changed: changing a probe's type is creating another one.
  // The history and the incidents would be about something else.
  const type = monitorTypeSchema.parse(current.type);

  const values: Partial<typeof monitors.$inferInsert> = { updatedAt: new Date() };
  let identityChanged = false;

  if (patch.config !== undefined || patch.intervalSeconds !== undefined) {
    const resolved = resolveConfig(
      type,
      patch.config ?? current.config,
      patch.intervalSeconds ?? current.intervalSeconds,
    );
    if (patch.config !== undefined) {
      values.config = resolved.config;
      identityChanged =
        JSON.stringify(resolved.config) !== JSON.stringify(current.config);
    }
    values.intervalSeconds = resolved.intervalSeconds;
  }

  if (patch.name !== undefined) values.name = patch.name;
  if (patch.failureThreshold !== undefined) values.failureThreshold = patch.failureThreshold;
  if (patch.recoveryThreshold !== undefined) values.recoveryThreshold = patch.recoveryThreshold;
  if (patch.applicationId !== undefined) values.applicationId = patch.applicationId;
  if (patch.webhookUrl !== undefined) {
    values.webhookUrlEncrypted = patch.webhookUrl === null ? null : encrypt(patch.webhookUrl);
  }
  if (patch.enabled !== undefined) {
    values.enabled = patch.enabled;
    // A manual resume erases the automatic pause reason, and makes the probe due
    // immediately.
    if (patch.enabled) {
      values.pausedReason = null;
      values.nextCheckAt = new Date();
    }
  }

  // Changing what is observed changes what the confirmed state means: it was about
  // something else. We start again from `unknown` rather than inherit a verdict
  // that became wrong.
  //
  // The open incident, though, **stays open**: it was announced, and those who
  // received it are waiting for what comes next. It will close — announcement
  // included — when the new target is confirmed healthy, at the recovery
  // threshold; if it fails, it is the same outage going on, without a second
  // alert. `applyCheck` reads the incident in the database to know.
  if (identityChanged) {
    values.status = 'unknown';
    values.lastOutcome = null;
    values.consecutiveFailures = 0;
    values.consecutiveSuccesses = 0;
    values.nextCheckAt = new Date();
  }

  /**
   * And if it is the **page** that changed, the visual reference is worth nothing
   * anymore: it would show another site than the one now monitored, and the next
   * before/after comparison would be a perfectly credible lie — two images side
   * by side, one of which has nothing to do with it.
   *
   * "Has the page changed" is asked of the **catalog** (`linkFor`), not of an
   * `if (type === 'http')`: raising the expected code or the timeout does not
   * change what is photographed, changing the URL does.
   *
   * References already **pinned** to an incident do not move: they document what
   * was monitored at that time, and rewriting the past would be worse than
   * keeping it.
   */
  if (values.config !== undefined) {
    const pageBefore = monitorTargetLink(type, current.config);
    const pageAfter = monitorTargetLink(type, values.config);
    if (pageBefore !== pageAfter) {
      await db
        .delete(monitorCaptures)
        .where(
          and(
            eq(monitorCaptures.monitorId, id),
            eq(monitorCaptures.kind, 'reference'),
            isNull(monitorCaptures.incidentId),
          ),
        );
    }
  }

  const [row] = await db.update(monitors).set(values).where(eq(monitors.id, id)).returning();
  return row ?? null;
}

export async function deleteMonitor(id: string, db: Database = getDb()): Promise<boolean> {
  const [row] = await db.delete(monitors).where(eq(monitors.id, id)).returning({ id: monitors.id });
  return row !== undefined;
}

export async function getMonitor(id: string, db: Database = getDb()): Promise<Monitor | null> {
  const [row] = await db.select().from(monitors).where(eq(monitors.id, id)).limit(1);
  return row ?? null;
}

export async function listMonitors(db: Database = getDb()): Promise<Monitor[]> {
  return db.select().from(monitors).orderBy(monitors.name);
}

/** The webhook's URL, decrypted. Reserved to the worker, at alert time. */
export function monitorWebhookUrl(monitor: Monitor): string | null {
  if (!monitor.webhookUrlEncrypted) return null;
  return decrypt(monitor.webhookUrlEncrypted);
}

/** A probe's target, in one line. Goes through the catalog, never through a `switch`. */
export function monitorTarget(monitor: Monitor, language: UiLanguage): string {
  if (!isMonitorType(monitor.type)) return `(${monitor.type})`;
  return describeMonitorTarget(monitor.type, monitor.config, language);
}

// ─── sweep ────────────────────────────────────────────────────────────────────

/**
 * Claims the due probes and **moves their due date in the same gesture**.
 *
 * Order matters: if we probed before moving `next_check_at`, a probe that takes
 * thirty seconds to time out would be picked up again by the next sweep, and we
 * would have two requests in flight toward the same target.
 * `FOR UPDATE SKIP LOCKED` also lets two workers share the work without stepping
 * on each other — the `supervision` queue has several slots.
 */
export async function claimDueMonitors(limit: number, db: Database = getDb()): Promise<Monitor[]> {
  // In two steps, and deliberately. The claim needs raw SQL —
  // `FOR UPDATE SKIP LOCKED` and `make_interval` have no equivalent in the query
  // builder — but `RETURNING m.*` would return snake_case columns, which Drizzle
  // does not remap. The fields would be `undefined`, and
  // `consecutiveSuccesses + 1` would be `NaN`: a probe the sweep would silently
  // break, while "probe now" (which goes through `getMonitor`) would work. The bug
  // existed; it will not come back.
  //
  // Atomicity still holds: it is the `UPDATE` that claims, and it only happens
  // once. The read that follows only types what is already ours.
  const claimed = await db.execute<{ id: string }>(sql`
    update ${monitors} as m
       set next_check_at = now() + make_interval(secs => m.interval_seconds)
     where m.id in (
       select id from ${monitors}
        where enabled
          and next_check_at <= now()
        order by next_check_at
        limit ${limit}
        for update skip locked
     )
    returning m.id
  `);

  const ids = readRows<{ id: string }>(claimed).map((row) => row.id);
  if (ids.length === 0) return [];

  return db.select().from(monitors).where(inArray(monitors.id, ids));
}

/** Makes a probe due immediately, without waiting for its due date. */
export async function markMonitorDue(id: string, db: Database = getDb()): Promise<void> {
  await db.update(monitors).set({ nextCheckAt: new Date() }).where(eq(monitors.id, id));
}

/** Pauses a probe, with its reason. The panel does it; a human can resume it. */
export async function suspendMonitor(
  id: string,
  reason: string,
  db: Database = getDb(),
): Promise<void> {
  await db
    .update(monitors)
    .set({ enabled: false, pausedReason: reason, updatedAt: new Date() })
    .where(eq(monitors.id, id));
}

/**
 * `db.execute()` returns either an array or a `{ rows }` depending on the
 * driver. Drizzle does not type it stably across versions: we normalize here,
 * once, rather than scatter casts.
 */
function readRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result !== null && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows: unknown }).rows;
    if (Array.isArray(rows)) return rows as T[];
  }
  return [];
}

// ─── recording a measurement ──────────────────────────────────────────────────

export type AppliedCheck = {
  monitor: Monitor;
  check: MonitorCheck;
  transition: MonitorTransition;
  /** Incident opened or closed by this measurement. `null` without a transition. */
  incident: MonitorIncident | null;
};

/**
 * A measurement, the resulting state and the possible incident — in a single
 * transaction. Otherwise a worker killed between inserting the measurement and
 * opening the incident would leave a down probe nobody would ever have been
 * warned about.
 *
 * `CheckResult` is the contract shared by every probe type: this code does not
 * know, and does not have to know, whether the measurement came from an HTTP
 * request or a TLS handshake.
 */
export async function applyCheck(
  monitor: Monitor,
  result: CheckResult,
  at: Date = new Date(),
  db: Database = getDb(),
): Promise<AppliedCheck> {
  const outcome = monitorOutcomeSchema.parse(result.outcome);
  const metrics: CheckMetrics = result.metrics ?? {};

  return db.transaction(async (tx) => {
    const [check] = await tx
      .insert(monitorChecks)
      .values({
        monitorId: monitor.id,
        checkedAt: at,
        outcome,
        latencyMs: result.latencyMs,
        detail: result.detail,
        metrics,
      })
      .returning();
    if (!check) throw new Error('measurement insert returned nothing');

    // The open incident is read in the database, not in the state: a target change
    // during an outage resets the state to `unknown` and leaves the incident open
    // (see `updateMonitor`).
    const [open] = await tx
      .select({ id: monitorIncidents.id })
      .from(monitorIncidents)
      .where(and(eq(monitorIncidents.monitorId, monitor.id), isNull(monitorIncidents.resolvedAt)))
      .limit(1);

    const step = nextMonitorState(
      {
        status: monitor.status,
        consecutiveFailures: monitor.consecutiveFailures,
        consecutiveSuccesses: monitor.consecutiveSuccesses,
        incidentOpen: open !== undefined,
      },
      outcome,
      {
        failureThreshold: monitor.failureThreshold,
        recoveryThreshold: monitor.recoveryThreshold,
      },
    );

    const [updated] = await tx
      .update(monitors)
      .set({
        status: step.status,
        lastOutcome: outcome,
        consecutiveFailures: step.consecutiveFailures,
        consecutiveSuccesses: step.consecutiveSuccesses,
        lastCheckedAt: at,
        lastLatencyMs: result.latencyMs,
        lastDetail: result.detail,
        lastMetrics: metrics,
        updatedAt: at,
      })
      .where(eq(monitors.id, monitor.id))
      .returning();
    if (!updated) throw new Error('probe update returned nothing');

    let incident: MonitorIncident | null = null;

    if (step.transition === 'down') {
      // `onConflictDoNothing` relies on the partial unique index: even if two workers
      // concluded an outage at the same time, there would be only one incident, hence
      // only one alert.
      const [opened] = await tx
        .insert(monitorIncidents)
        .values({
          monitorId: monitor.id,
          startedAt: at,
          cause: outcome,
          detail: result.detail,
          metrics,
          failureCount: step.consecutiveFailures,
        })
        .onConflictDoNothing()
        .returning();
      incident = opened ?? null;
    }

    if (step.transition === 'up') {
      const [closed] = await tx
        .update(monitorIncidents)
        .set({ resolvedAt: at })
        .where(and(eq(monitorIncidents.monitorId, monitor.id), isNull(monitorIncidents.resolvedAt)))
        .returning();
      incident = closed ?? null;
    }

    return { monitor: updated, check, transition: step.transition, incident };
  });
}

export async function markIncidentAlerted(
  incidentId: string,
  kind: 'open' | 'resolve',
  delivery: { ok: boolean; error?: string },
  db: Database = getDb(),
): Promise<void> {
  const now = new Date();
  const values =
    kind === 'open'
      ? { alertSentAt: delivery.ok ? now : null, alertError: delivery.error ?? null }
      : { resolveAlertSentAt: delivery.ok ? now : null, resolveAlertError: delivery.error ?? null };
  await db.update(monitorIncidents).set(values).where(eq(monitorIncidents.id, incidentId));
}

// ─── screen reads ─────────────────────────────────────────────────────────────

export async function listChecks(
  monitorId: string,
  limit = 100,
  db: Database = getDb(),
): Promise<MonitorCheck[]> {
  return db
    .select()
    .from(monitorChecks)
    .where(eq(monitorChecks.monitorId, monitorId))
    .orderBy(desc(monitorChecks.checkedAt))
    .limit(limit);
}

export async function listIncidents(
  monitorId: string,
  limit = 50,
  db: Database = getDb(),
): Promise<MonitorIncident[]> {
  return db
    .select()
    .from(monitorIncidents)
    .where(eq(monitorIncidents.monitorId, monitorId))
    .orderBy(desc(monitorIncidents.startedAt))
    .limit(limit);
}

export async function openIncidentFor(
  monitorId: string,
  db: Database = getDb(),
): Promise<MonitorIncident | null> {
  const [row] = await db
    .select()
    .from(monitorIncidents)
    .where(and(eq(monitorIncidents.monitorId, monitorId), isNull(monitorIncidents.resolvedAt)))
    .limit(1);
  return row ?? null;
}

/**
 * Availability rate over a window, for several probes at once.
 *
 * Returns the **denominator** with the rate: "100% over 3 measurements" is not
 * "100% over 1,440", and the screen must be able to say it. A probe without any
 * measurement in the window returns `ratio: null` — never 0%.
 */
export async function uptimeWindows(
  monitorIds: readonly string[],
  hours: number,
  db: Database = getDb(),
): Promise<Map<string, UptimeWindow>> {
  const out = new Map<string, UptimeWindow>();
  for (const id of monitorIds) out.set(id, { hours, samples: 0, up: 0, ratio: null });
  if (monitorIds.length === 0) return out;

  const rows = await db
    .select({
      monitorId: monitorChecks.monitorId,
      samples: sql<number>`count(*)::int`,
      up: sql<number>`count(*) filter (where ${monitorChecks.outcome} = 'healthy')::int`,
    })
    .from(monitorChecks)
    .where(
      and(
        inArray(monitorChecks.monitorId, [...monitorIds]),
        sql`${monitorChecks.checkedAt} >= now() - make_interval(hours => ${hours})`,
      ),
    )
    .groupBy(monitorChecks.monitorId);

  for (const row of rows) {
    out.set(row.monitorId, {
      hours,
      samples: row.samples,
      up: row.up,
      ratio: uptimeRatio(row.up, row.samples),
    });
  }
  return out;
}

// ─── link with deployments ────────────────────────────────────────────────────

export type AdoptableApp = {
  applicationId: string;
  slug: string;
  name: string;
  url: string;
  targetId: string;
};

/**
 * The deployed, reachable applications that are not monitored yet.
 *
 * The panel **already knows the URL of everything it deploys**: it is its
 * advantage over an external tool. It does not create the probe by itself,
 * though — the reasoning is in the `/api/monitors` route. It offers, in one
 * click.
 */
export async function listAdoptableApps(db: Database = getDb()): Promise<AdoptableApp[]> {
  const rows = await db.execute<AdoptableApp>(sql`
    select distinct on (d.application_id)
           d.application_id as "applicationId",
           a.slug           as "slug",
           a.name           as "name",
           d.url            as "url",
           d.target_id      as "targetId"
      from ${deployments} d
      join ${applications} a on a.id = d.application_id
     where d.status in ('success', 'rolled_back')
       and d.url is not null
       and not exists (
         select 1 from ${monitors} m where m.application_id = d.application_id
       )
     order by d.application_id, d.version desc
  `);
  return readRows<AdoptableApp>(rows);
}

/**
 * Pauses the probes whose attached application no longer has a deployment in
 * service.
 *
 * Without this, deliberately destroying an application would trigger an outage
 * alert — the worst false positive there is, because it teaches ignoring
 * alerts. The probe is not deleted: it is paused with its reason, and resumes
 * in one click.
 *
 * The written reason is a **key**, not a sentence: this column outlives the
 * pause, and a sentence would have frozen the language of the sweep's day in it.
 * The complete reasoning is on `MONITOR_PAUSE_ORPHANED`, on the `@pupitre/core`
 * side.
 */
export async function suspendOrphanedMonitors(db: Database = getDb()): Promise<number> {
  const rows = await db.execute<{ id: string }>(sql`
    update ${monitors} as m
       set enabled = false,
           paused_reason = ${MONITOR_PAUSE_ORPHANED},
           updated_at = now()
     where m.enabled
       and m.application_id is not null
       and not exists (
         select 1 from ${deployments} d
          where d.application_id = m.application_id
            and d.status in ('success', 'rolled_back')
            and d.url is not null
       )
    returning m.id
  `);
  return readRows<{ id: string }>(rows).length;
}

// ─── retention ────────────────────────────────────────────────────────────────

/**
 * Purges the time series beyond retention.
 *
 * In batches: a `DELETE` of several million rows would hold the table for its
 * whole duration, and the next probe would wait behind it. **Incidents are
 * never purged** — they are rare and they tell the story; a truncated timeline
 * is worth nothing.
 */
export async function pruneMonitorChecks(
  days: number,
  batch: number = MONITOR_PRUNE_BATCH,
  db: Database = getDb(),
): Promise<number> {
  const rows = await db.execute<{ id: string }>(sql`
    delete from ${monitorChecks}
     where id in (
       select id from ${monitorChecks}
        where checked_at < now() - make_interval(days => ${days})
        limit ${batch}
     )
    returning id
  `);
  return readRows<{ id: string }>(rows).length;
}
