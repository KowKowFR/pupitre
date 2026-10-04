import { DEPLOYMENT_STEPS, type DeploymentStatus, type DeploymentStepKey } from '@pupitre/core';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { getDb, type Database } from './client.js';
import { applications, targets } from './schema/infra.js';
import { deployments, deploymentSteps } from './schema/deployments.js';
import { monitorChecks, monitors } from './schema/monitors.js';
import { auditLogs } from './schema/ops.js';
import { findings, scanRuns } from './schema/security.js';
import type { HistoryPoint, TargetHistory } from './target-metrics.js';

/**
 * Dashboard aggregations — the time dimension.
 *
 * ── Why a separate module ───────────────────────────────────────────────────
 * The existing reads all answer "what is X's state *right now*". The dashboard
 * asks the other question: "what has happened since yesterday". These are
 * bucketed queries, cutting across every domain, and belonging to none of them.
 * Putting them in `monitors.ts` or `deployments.ts` would bring a screen concern
 * into them.
 *
 * ── The rule that governs this whole file ───────────────────────────────────
 * **No series leaves here without its denominator.** Each bucket carries its
 * number of readings, and a bucket without a reading goes out with `samples: 0`
 * and a `null` value — never a zero. A dashboard that draws a zero where it
 * measured nothing asserts that all was well at a moment it did not look at, and
 * that is exactly the lie we want to make impossible.
 *
 * The consequence for the caller: `Coverage` is made to be *shown*, not only
 * consulted. A screen that receives `covered: 2` out of `buckets: 24` must say
 * "two hours of readings out of twenty-four", not draw a flat curve.
 */

// ─── the time template ────────────────────────────────────────────────────────

/**
 * The window and its split. The bounds are **aligned on the epoch**, as
 * `targetHistories` already does: two series computed separately therefore fall
 * on exactly the same buckets, and can share an axis. It is the only reason the
 * dashboard can overlay probes, a machine load and deployments without shifting
 * them by half an hour.
 */
export type PulseWindow = {
  hours: number;
  buckets: number;
  bucketSeconds: number;
  /** Start of the first bucket, ISO. */
  from: string;
  /** End of the last bucket, ISO. */
  to: string;
};

/**
 * What the window really contains — the opposite of a promise.
 *
 * `buckets` is what was asked for, `covered` what was measured. The gap between
 * the two is the most important information of a thin data set.
 */
export type Coverage = {
  buckets: number;
  /** Buckets carrying at least one reading. */
  covered: number;
  /** Total readings over the window. */
  samples: number;
  /** First and last real reading — the bounds of what we know. */
  firstAt: string | null;
  lastAt: string | null;
};

/**
 * Builds the template. `now` is injectable so that the computation stays
 * deterministic in tests; in service it is the panel's clock.
 *
 * The last bucket is the one that **contains** the present instant, not the one
 * before it: otherwise the measurement taken thirty seconds ago would have
 * nowhere to land, and the dashboard would seem an hour late.
 */
export function pulseWindow(hours: number, buckets: number, now = new Date()): PulseWindow {
  const bucketSeconds = Math.max(60, Math.round((hours * 3600) / buckets));
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const lastStart = Math.floor(nowSeconds / bucketSeconds) * bucketSeconds;
  const firstStart = lastStart - (buckets - 1) * bucketSeconds;
  return {
    hours,
    buckets,
    bucketSeconds,
    from: new Date(firstStart * 1000).toISOString(),
    to: new Date((lastStart + bucketSeconds) * 1000).toISOString(),
  };
}

/** The bucket starts, from oldest to newest. */
function bucketStarts(window: PulseWindow): number[] {
  const first = Math.floor(Date.parse(window.from) / 1000);
  return Array.from({ length: window.buckets }, (_, i) => first + i * window.bucketSeconds);
}

/**
 * The index of the bucket that hosts an instant, or `null` if it falls outside
 * the template.
 *
 * The final clamp is not superstition: the template is computed with the
 * panel's clock and the rows with Postgres's `now()`. At a bucket's switch, a
 * few milliseconds of gap would be enough to make the most recent measurement
 * disappear — the one looked at first.
 */
function bucketIndex(window: PulseWindow, at: Date): number | null {
  const first = Math.floor(Date.parse(window.from) / 1000);
  const seconds = Math.floor(at.getTime() / 1000);
  const index = Math.floor((seconds - first) / window.bucketSeconds);
  if (index < 0) return null;
  return index >= window.buckets ? window.buckets - 1 : index;
}

function coverageOf(
  points: readonly { at: string; samples: number }[],
  window: PulseWindow,
  firstAt: string | null,
  lastAt: string | null,
): Coverage {
  let covered = 0;
  let samples = 0;
  for (const point of points) {
    if (point.samples > 0) covered += 1;
    samples += point.samples;
  }
  return { buckets: window.buckets, covered, samples, firstAt, lastAt };
}

/**
 * The bucket expression, in epoch seconds.
 *
 * `sql.raw` and not a bound parameter, for the reason already documented in
 * `targetHistories`: the same expression appears in the SELECT and in the GROUP
 * BY, and Postgres does not recognize two placeholders as a single expression.
 * `bucketSeconds` comes out of a `Math.round` on integers, never out of a
 * string: no injection possible.
 */
function bucketExpression(column: unknown, bucketSeconds: number) {
  const seconds = sql.raw(String(bucketSeconds));
  return sql<string>`to_timestamp(floor(extract(epoch from ${column}) / ${seconds}) * ${seconds})`;
}

// ─── probes pulse ─────────────────────────────────────────────────────────────

export type MonitorPulsePoint = {
  at: string;
  /** Measurements taken in the bucket. Zero means "we did not look". */
  samples: number;
  healthy: number;
  latencyAvgMs: number | null;
  latencyMaxMs: number | null;
};

export type MonitorPulse = {
  window: PulseWindow;
  coverage: Coverage;
  points: MonitorPulsePoint[];
  /** Active probes that produced at least one measurement over the window. */
  monitorsSeen: number;
};

/**
 * The measured availability, bucket by bucket, all probes together.
 *
 * ── Why the hourly bucket, and not finer ────────────────────────────────────
 * The probes' real rate is not regular: it depends on the scheduler, which may
 * have been stopped. On this instance's data one observes one measurement per
 * hour for half a day, then fifty per hour. A ten-minute bucket would make the
 * first half almost entirely empty and suggest a probe outage where there is
 * only a slow rhythm. The hourly bucket is the finest that keeps a chance of
 * being populated — and the measurement count that goes with it says the rest.
 *
 * The rate is **not** computed here. `healthy / samples` on a bucket with a
 * single measurement is 0% or 100% and nothing else; it is for the screen to
 * decide whether it draws that as a value or as an uncertainty, and it can only
 * do so if it sees the denominator.
 */
export async function monitorPulse(
  hours = 24,
  buckets = 24,
  db: Database = getDb(),
): Promise<MonitorPulse> {
  const window = pulseWindow(hours, buckets);
  const bucket = bucketExpression(monitorChecks.checkedAt, window.bucketSeconds);

  const rows = await db
    .select({
      at: bucket,
      samples: sql<number>`count(*)::int`,
      healthy: sql<number>`count(*) filter (where ${monitorChecks.outcome} = 'healthy')::int`,
      latencyAvgMs: sql<number | null>`round(avg(${monitorChecks.latencyMs}))::int`,
      latencyMaxMs: sql<number | null>`max(${monitorChecks.latencyMs})::int`,
      monitorsSeen: sql<number>`count(distinct ${monitorChecks.monitorId})::int`,
      firstAt: sql<string>`min(${monitorChecks.checkedAt})`,
      lastAt: sql<string>`max(${monitorChecks.checkedAt})`,
    })
    .from(monitorChecks)
    .innerJoin(monitors, eq(monitors.id, monitorChecks.monitorId))
    .where(
      and(
        eq(monitors.enabled, true),
        sql`${monitorChecks.checkedAt} >= now() - make_interval(hours => ${hours})`,
      ),
    )
    .groupBy(bucket)
    .orderBy(asc(bucket));

  const points: MonitorPulsePoint[] = bucketStarts(window).map((start) => ({
    at: new Date(start * 1000).toISOString(),
    samples: 0,
    healthy: 0,
    latencyAvgMs: null,
    latencyMaxMs: null,
  }));

  const seen = new Set<number>();
  let firstAt: string | null = null;
  let lastAt: string | null = null;
  let monitorsSeen = 0;

  for (const row of rows) {
    const index = bucketIndex(window, new Date(row.at));
    if (index === null) continue;
    const point = points[index];
    if (!point) continue;
    point.samples += row.samples;
    point.healthy += row.healthy;
    point.latencyAvgMs = row.latencyAvgMs;
    point.latencyMaxMs = row.latencyMaxMs;
    seen.add(index);
    monitorsSeen = Math.max(monitorsSeen, row.monitorsSeen);
    const rowFirst = new Date(row.firstAt).toISOString();
    const rowLast = new Date(row.lastAt).toISOString();
    if (firstAt === null || rowFirst < firstAt) firstAt = rowFirst;
    if (lastAt === null || rowLast > lastAt) lastAt = rowLast;
  }

  return {
    window,
    coverage: coverageOf(points, window, firstAt, lastAt),
    points,
    monitorsSeen,
  };
}

// ─── activity pulse ───────────────────────────────────────────────────────────

export type ActivityPoint = { at: string; samples: number; denied: number };

export type ActivityPulse = {
  window: PulseWindow;
  coverage: Coverage;
  points: ActivityPoint[];
  total: number;
  /** Permission refusals — the only audit line that calls for a decision. */
  denied: number;
};

/**
 * The volume of logged actions, bucket by bucket.
 *
 * We isolate `permission.denied` because it is the only audit action that says
 * something without opening the log: someone asked for what they are not
 * allowed to do. The rest of the volume is a measure of agitation, useful to
 * place an incident in time, never to judge.
 */
export async function activityPulse(
  hours = 24,
  buckets = 24,
  db: Database = getDb(),
): Promise<ActivityPulse> {
  const window = pulseWindow(hours, buckets);
  const bucket = bucketExpression(auditLogs.createdAt, window.bucketSeconds);

  const rows = await db
    .select({
      at: bucket,
      samples: sql<number>`count(*)::int`,
      denied: sql<number>`count(*) filter (where ${auditLogs.action} = 'permission.denied')::int`,
      firstAt: sql<string>`min(${auditLogs.createdAt})`,
      lastAt: sql<string>`max(${auditLogs.createdAt})`,
    })
    .from(auditLogs)
    .where(sql`${auditLogs.createdAt} >= now() - make_interval(hours => ${hours})`)
    .groupBy(bucket)
    .orderBy(asc(bucket));

  const points: ActivityPoint[] = bucketStarts(window).map((start) => ({
    at: new Date(start * 1000).toISOString(),
    samples: 0,
    denied: 0,
  }));

  let firstAt: string | null = null;
  let lastAt: string | null = null;
  let total = 0;
  let denied = 0;

  for (const row of rows) {
    const index = bucketIndex(window, new Date(row.at));
    if (index === null) continue;
    const point = points[index];
    if (!point) continue;
    point.samples += row.samples;
    point.denied += row.denied;
    total += row.samples;
    denied += row.denied;
    const rowFirst = new Date(row.firstAt).toISOString();
    const rowLast = new Date(row.lastAt).toISOString();
    if (firstAt === null || rowFirst < firstAt) firstAt = rowFirst;
    if (lastAt === null || rowLast > lastAt) lastAt = rowLast;
  }

  return { window, coverage: coverageOf(points, window, firstAt, lastAt), points, total, denied };
}

// ─── deployments chronicle ────────────────────────────────────────────────────

export type DeploymentEvent = {
  id: string;
  /** Run number, global to the instance. */
  number: number;
  at: string;
  finishedAt: string | null;
  status: DeploymentStatus;
  applicationSlug: string;
  targetName: string;
  runtime: 'docker' | 'k3s';
  version: number;
  /** The pipeline's real duration, or `null` if it is not finished. */
  durationSeconds: number | null;
  failedStep: string | null;
};

/** A pipeline step and the share of times it breaks. */
export type StepWeakness = {
  key: DeploymentStepKey | string;
  label: string;
  failed: number;
  /** Runs of the step that reached a verdict — `skipped` excluded. */
  decided: number;
};

export type DeploymentPulse = {
  days: number;
  events: DeploymentEvent[];
  tallies: {
    total: number;
    succeeded: number;
    failed: number;
    rolledBack: number;
    destroyed: number;
    inFlight: number;
  };
  /** Steps that failed at least once, the most fragile first. */
  weaknesses: StepWeakness[];
  /** Median duration of a finished pipeline, in seconds. `null` under three measurements. */
  medianDurationSeconds: number | null;
};

const STEP_LABELS = new Map<string, string>(
  DEPLOYMENT_STEPS.map((step) => [step.key, step.label]),
);

/**
 * The window's deployments, one by one, plus what can be said about them.
 *
 * ── Why events and not a rate ───────────────────────────────────────────────
 * The temptation is to draw "success rate per day". On a fleet that deploys
 * eight times in thirty-six hours, that rate is 100% or 50% and moves by a
 * quarter at each deployment: it is noise drawn as a trend. A chronicle of
 * events placed on a time axis says the same thing without making anything up —
 * and it stays right the day there are a thousand.
 *
 * `medianDurationSeconds` comes out `null` under three finished pipelines, for
 * the same reason: a median over two values is one of the two values.
 *
 * ── Why `rolled_back` counts separately ─────────────────────────────────────
 * A rollback is neither a deployment success nor a failure: the pipeline did
 * exactly what it was asked — observe that the new version did not answer, and
 * put the old one back. Merging it into failures would erase the fact that the
 * safeguard worked; merging it into successes would erase the fact that the
 * delivered version was bad.
 */
export async function deploymentPulse(days = 7, db: Database = getDb()): Promise<DeploymentPulse> {
  const rows = await db
    .select({
      id: deployments.id,
      number: deployments.number,
      at: deployments.createdAt,
      startedAt: deployments.startedAt,
      finishedAt: deployments.finishedAt,
      status: deployments.status,
      applicationSlug: applications.slug,
      targetName: targets.name,
      runtime: deployments.runtime,
      version: deployments.version,
      failedStep: deployments.failedStep,
    })
    .from(deployments)
    .innerJoin(applications, eq(applications.id, deployments.applicationId))
    .innerJoin(targets, eq(targets.id, deployments.targetId))
    .where(sql`${deployments.createdAt} >= now() - make_interval(days => ${days})`)
    .orderBy(asc(deployments.createdAt));

  const events: DeploymentEvent[] = rows.map((row) => ({
    id: row.id,
    number: row.number,
    at: row.at.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    status: row.status,
    applicationSlug: row.applicationSlug,
    targetName: row.targetName,
    runtime: row.runtime,
    version: row.version,
    durationSeconds:
      row.startedAt && row.finishedAt
        ? Math.max(0, Math.round((row.finishedAt.getTime() - row.startedAt.getTime()) / 1000))
        : null,
    failedStep: row.failedStep,
  }));

  const tallies = {
    total: events.length,
    succeeded: events.filter((event) => event.status === 'success').length,
    failed: events.filter((event) => event.status === 'failed').length,
    rolledBack: events.filter((event) => event.status === 'rolled_back').length,
    destroyed: events.filter((event) => event.status === 'destroyed').length,
    inFlight: events.filter((event) => event.status === 'pending' || event.status === 'running')
      .length,
  };

  const ids = rows.map((row) => row.id);
  const weaknesses: StepWeakness[] = [];

  if (ids.length > 0) {
    const stepRows = await db
      .select({
        key: deploymentSteps.key,
        failed: sql<number>`count(*) filter (where ${deploymentSteps.status} = 'failed')::int`,
        decided: sql<number>`count(*) filter (where ${deploymentSteps.status} in ('failed', 'success'))::int`,
      })
      .from(deploymentSteps)
      .where(inArray(deploymentSteps.deploymentId, ids))
      .groupBy(deploymentSteps.key);

    for (const row of stepRows) {
      if (row.failed === 0) continue;
      weaknesses.push({
        key: row.key,
        label: STEP_LABELS.get(row.key) ?? row.key,
        failed: row.failed,
        decided: row.decided,
      });
    }
    weaknesses.sort((a, b) => b.failed - a.failed || a.key.localeCompare(b.key));
  }

  const durations = events
    .map((event) => event.durationSeconds)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);

  return {
    days,
    events,
    tallies,
    weaknesses,
    medianDurationSeconds:
      durations.length >= 3 ? (durations[Math.floor(durations.length / 2)] ?? null) : null,
  };
}

// ─── security posture ─────────────────────────────────────────────────────────

export type ScanPosture = {
  days: number;
  runs: number;
  lastAt: string | null;
  bySeverity: { critical: number; high: number; medium: number; low: number; other: number };
  /** Among the critical ones, those a version fixes: what can be fixed right away. */
  fixableCritical: number;
  /**
   * Runs declared "pass" that nevertheless carried critical or high ones, because
   * the gate (`fail_on`) was set to `none`.
   *
   * It is not a curiosity: it is the only place in the product where a reassuring
   * figure covers a fact that is not. The dashboard must say it.
   */
  passedWithSevere: number;
};

/** The state of the window's analyses, and whether their verdict means anything. */
export async function scanPosture(days = 7, db: Database = getDb()): Promise<ScanPosture> {
  const within = sql`${scanRuns.createdAt} >= now() - make_interval(days => ${days})`;

  const [totals] = await db
    .select({
      runs: sql<number>`count(*)::int`,
      lastAt: sql<string | null>`max(${scanRuns.createdAt})`,
    })
    .from(scanRuns)
    .where(within);

  const severityRows = await db
    .select({
      severity: findings.severity,
      value: sql<number>`count(*)::int`,
      fixable: sql<number>`count(*) filter (where coalesce(${findings.fixedVersion}, '') <> '')::int`,
    })
    .from(findings)
    .innerJoin(scanRuns, eq(scanRuns.id, findings.scanRunId))
    .where(within)
    .groupBy(findings.severity);

  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, other: 0 };
  let fixableCritical = 0;
  for (const row of severityRows) {
    if (row.severity === 'critical') fixableCritical += row.fixable;
    if (row.severity === 'critical') bySeverity.critical += row.value;
    else if (row.severity === 'high') bySeverity.high += row.value;
    else if (row.severity === 'medium') bySeverity.medium += row.value;
    else if (row.severity === 'low') bySeverity.low += row.value;
    else bySeverity.other += row.value;
  }

  // A `count(distinct)` rather than a sub-select: a run carrying thirty critical
  // vulnerabilities stays one run, not thirty.
  const [gate] = await db
    .select({ value: sql<number>`count(distinct ${scanRuns.id})::int` })
    .from(scanRuns)
    .innerJoin(findings, eq(findings.scanRunId, scanRuns.id))
    .where(
      and(
        within,
        eq(scanRuns.verdict, 'pass'),
        eq(scanRuns.failOn, 'none'),
        inArray(findings.severity, ['critical', 'high']),
      ),
    );

  return {
    days,
    runs: totals?.runs ?? 0,
    lastAt: totals?.lastAt ? new Date(totals.lastAt).toISOString() : null,
    bySeverity,
    fixableCritical,
    passedWithSevere: gate?.value ?? 0,
  };
}

// ─── folding the fleet onto a single axis ─────────────────────────────────────

export type FleetPoint = {
  at: string;
  /** Readings taken over the whole fleet in this bucket. */
  samples: number;
  /** Machines that answered at least once in this bucket. */
  targets: number;
  loadPercent: number | null;
  memoryPercent: number | null;
  diskPercent: number | null;
};

export type FleetPulse = { window: PulseWindow; coverage: Coverage; points: FleetPoint[] };

/**
 * Folds the per-machine histories into a single "worst of the fleet" series.
 *
 * A pure function, and deliberately not a query: `targetHistories` already does
 * exactly the right work in one indexed query, and the dashboard needs the
 * per-machine detail for its list anyway. Adding a second SQL to recompute the
 * maximum of what is already held in memory would cost a round trip and one
 * more chance to diverge.
 *
 * `max` and not `avg`, for the reason written in `targetHistories`: we are
 * looking at saturation, and the fleet's average drowns the machine that
 * chokes.
 */
export function foldFleet(
  histories: Iterable<TargetHistory>,
  window: PulseWindow,
): FleetPulse {
  const points: FleetPoint[] = bucketStarts(window).map((start) => ({
    at: new Date(start * 1000).toISOString(),
    samples: 0,
    targets: 0,
    loadPercent: null,
    memoryPercent: null,
    diskPercent: null,
  }));

  const worst = (current: number | null, candidate: number | null): number | null =>
    candidate === null ? current : current === null ? candidate : Math.max(current, candidate);

  let firstAt: string | null = null;
  let lastAt: string | null = null;

  for (const history of histories) {
    for (const point of history.points as readonly HistoryPoint[]) {
      const index = bucketIndex(window, new Date(point.at));
      if (index === null) continue;
      const slot = points[index];
      if (!slot) continue;
      slot.samples += point.samples;
      if (point.samples > 0) slot.targets += 1;
      slot.loadPercent = worst(slot.loadPercent, point.loadPercent);
      slot.memoryPercent = worst(slot.memoryPercent, point.memoryPercent);
      slot.diskPercent = worst(slot.diskPercent, point.diskPercent);
      if (firstAt === null || point.at < firstAt) firstAt = point.at;
      if (lastAt === null || point.at > lastAt) lastAt = point.at;
    }
  }

  return { window, coverage: coverageOf(points, window, firstAt, lastAt), points };
}
