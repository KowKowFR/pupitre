import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Forecast, ForecastSubjectType, SeriesPoint } from '@pupitre/core';
import { getDb, type Database } from './client.js';
import { applications } from './schema/infra.js';
import { backupPolicies, backups } from './schema/backups.js';
import { deployments } from './schema/deployments.js';
import { forecasts, type ForecastRow } from './schema/forecasts.js';
import { monitorChecks } from './schema/monitors.js';
import { targetMetricSamples } from './schema/target-metrics.js';

/**
 * Forecasts in the database: their episodes, and the series the sweep reads to
 * compute them. The computation itself is in `@pupitre/core` (pure, tested on
 * made-up series); here, only reads and writing the episodes.
 */

export type { ForecastRow };

/** Foreign key violation on the PostgreSQL side — direct, or wrapped by Drizzle. */
function isForeignKeyViolation(error: unknown): boolean {
  for (let current = error; typeof current === 'object' && current !== null;) {
    if ((current as { code?: unknown }).code === '23503') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

const keyOf = (kind: string, subjectType: string, subjectId: string) =>
  `${kind}|${subjectType}|${subjectId}`;

/**
 * Matches the open episodes with the sweep's findings: a new finding opens an
 * episode, a lasting finding updates it, an episode without a finding closes.
 * Returns what opened and closed — that, and only that, is written to the log
 * and goes out as a notification.
 */
export async function syncForecasts(
  found: readonly Forecast[],
  now: Date = new Date(),
  db: Database = getDb(),
): Promise<{ opened: ForecastRow[]; cleared: ForecastRow[]; open: number }> {
  return db.transaction(async (tx) => {
    const current = await tx.select().from(forecasts).where(isNull(forecasts.resolvedAt));
    const byKey = new Map(
      current.map((row) => [keyOf(row.kind, row.subjectType, row.subjectId), row]),
    );
    const seen = new Set<string>();
    const opened: ForecastRow[] = [];

    for (const forecast of found) {
      const key = keyOf(forecast.kind, forecast.subject.type, forecast.subject.id);
      if (seen.has(key)) continue;
      seen.add(key);
      const values = {
        subjectName: forecast.subject.name,
        severity: forecast.severity,
        etaAt: forecast.etaAt ? new Date(forecast.etaAt) : null,
        detail: forecast.detail,
        lastSeenAt: now,
      };
      const existing = byKey.get(key);
      if (existing) {
        await tx.update(forecasts).set(values).where(eq(forecasts.id, existing.id));
      } else {
        // One savepoint per opening: a subject deleted between the sweep's read and this
        // write makes the row be refused by its foreign key — there is nothing left to
        // forecast, and the rest of the sweep must go through anyway.
        try {
          const [row] = await tx.transaction((savepoint) =>
            savepoint
              .insert(forecasts)
              .values({
                kind: forecast.kind,
                subjectType: forecast.subject.type,
                subjectId: forecast.subject.id,
                openedAt: now,
                ...values,
              })
              .returning(),
          );
          if (row) opened.push(row);
        } catch (error) {
          if (!isForeignKeyViolation(error)) throw error;
        }
      }
    }

    const cleared: ForecastRow[] = [];
    for (const row of current) {
      if (seen.has(keyOf(row.kind, row.subjectType, row.subjectId))) continue;
      const [closed] = await tx
        .update(forecasts)
        .set({ resolvedAt: now })
        .where(eq(forecasts.id, row.id))
        .returning();
      if (closed) cleared.push(closed);
    }

    return { opened, cleared, open: seen.size };
  });
}

/** The ongoing forecasts: "soon" first, then by due date. */
export async function listOpenForecasts(
  filter: { subjectType?: ForecastSubjectType; subjectId?: string } = {},
  db: Database = getDb(),
): Promise<ForecastRow[]> {
  return db
    .select()
    .from(forecasts)
    .where(
      and(
        isNull(forecasts.resolvedAt),
        filter.subjectType ? eq(forecasts.subjectType, filter.subjectType) : undefined,
        filter.subjectId ? eq(forecasts.subjectId, filter.subjectId) : undefined,
      ),
    )
    .orderBy(
      sql`case when ${forecasts.severity} = 'soon' then 0 else 1 end`,
      sql`${forecasts.etaAt} asc nulls last`,
      asc(forecasts.openedAt),
    );
}

// ─── The sweep's series ───────────────────────────────────────────────────────

/**
 * A machine's readings, as hourly averages over `days` days: enough to draw a
 * slope without dragging 4,000 rows per machine. An unreachable machine's
 * readings do not count — they measure nothing.
 */
export async function targetHourlySeries(
  targetId: string,
  days: number,
  db: Database = getDb(),
): Promise<{
  disk: SeriesPoint[];
  memory: SeriesPoint[];
  load: SeriesPoint[];
  diskSizeKb: number | null;
}> {
  const hour = sql<Date>`date_trunc('hour', ${targetMetricSamples.sampledAt})`;
  const rows = await db
    .select({
      hour,
      disk: sql<number | null>`avg(${targetMetricSamples.diskPercent})`,
      memory: sql<number | null>`avg(${targetMetricSamples.memoryPercent})`,
      load: sql<number | null>`avg(${targetMetricSamples.loadPercent})`,
      diskSizeKb: sql<number | null>`max(${targetMetricSamples.diskSizeKb})`,
    })
    .from(targetMetricSamples)
    .where(
      and(
        eq(targetMetricSamples.targetId, targetId),
        eq(targetMetricSamples.reachable, true),
        sql`${targetMetricSamples.sampledAt} > now() - make_interval(days => ${days})`,
      ),
    )
    .groupBy(hour)
    .orderBy(hour);

  const points = (pick: (row: (typeof rows)[number]) => number | null): SeriesPoint[] =>
    rows.flatMap((row) => {
      const value = pick(row);
      return value === null ? [] : [{ t: new Date(row.hour).getTime(), v: Number(value) }];
    });
  const last = rows.at(-1);
  return {
    disk: points((row) => row.disk),
    memory: points((row) => row.memory),
    load: points((row) => row.load),
    diskSizeKb: last?.diskSizeKb === null || last === undefined ? null : Number(last.diskSizeKb),
  };
}

/**
 * For each probe: the median latency of the last 24 h and of the six days
 * before, with the number of measurements on each side, and the number of flips
 * (healthy ↔ not healthy) of the last 24 h. One query for all probes.
 */
export async function monitorForecastWindows(db: Database = getDb()): Promise<
  Map<
    string,
    {
      recentMedian: number | null;
      recentCount: number;
      baselineMedian: number | null;
      baselineCount: number;
      flips: number;
    }
  >
> {
  const result = await db.execute<{
    monitor_id: string;
    recent_median: number | null;
    recent_count: number;
    baseline_median: number | null;
    baseline_count: number;
    flips: number;
  }>(sql`
    with checks as (
      select
        ${monitorChecks.monitorId} as monitor_id,
        ${monitorChecks.checkedAt} as checked_at,
        ${monitorChecks.latencyMs} as latency_ms,
        ${monitorChecks.outcome} as outcome
      from ${monitorChecks}
      where ${monitorChecks.checkedAt} > now() - interval '7 days'
    ),
    flips as (
      select monitor_id,
        count(*) filter (where changed)::int as flips
      from (
        select monitor_id,
          (outcome = 'healthy') <> lag(outcome = 'healthy') over (
            partition by monitor_id order by checked_at
          ) as changed
        from checks
        where checked_at > now() - interval '24 hours'
      ) ordered
      group by monitor_id
    )
    select
      c.monitor_id,
      percentile_cont(0.5) within group (order by c.latency_ms)
        filter (where c.checked_at > now() - interval '24 hours' and c.outcome = 'healthy') as recent_median,
      count(*) filter (where c.checked_at > now() - interval '24 hours' and c.outcome = 'healthy' and c.latency_ms is not null)::int as recent_count,
      percentile_cont(0.5) within group (order by c.latency_ms)
        filter (where c.checked_at <= now() - interval '24 hours' and c.outcome = 'healthy') as baseline_median,
      count(*) filter (where c.checked_at <= now() - interval '24 hours' and c.outcome = 'healthy' and c.latency_ms is not null)::int as baseline_count,
      coalesce(max(f.flips), 0)::int as flips
    from checks c
    left join flips f on f.monitor_id = c.monitor_id
    group by c.monitor_id
  `);
  const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as Array<{
    monitor_id: string;
    recent_median: number | string | null;
    recent_count: number;
    baseline_median: number | string | null;
    baseline_count: number;
    flips: number;
  }>;
  return new Map(
    rows.map((row) => [
      row.monitor_id,
      {
        recentMedian: row.recent_median === null ? null : Number(row.recent_median),
        recentCount: Number(row.recent_count),
        baselineMedian: row.baseline_median === null ? null : Number(row.baseline_median),
        baselineCount: Number(row.baseline_count),
        flips: Number(row.flips),
      },
    ]),
  );
}

/**
 * The applications whose backup is active, with their last successful backup
 * and the date since which the policy holds.
 */
export async function backupFreshness(
  db: Database = getDb(),
): Promise<
  Array<{ applicationId: string; slug: string; enabledSince: Date; lastSuccessAt: Date | null }>
> {
  const lastSuccess = db
    .select({
      applicationId: backups.applicationId,
      at: sql<Date>`max(${backups.finishedAt})`.as('at'),
    })
    .from(backups)
    .where(and(eq(backups.kind, 'application'), eq(backups.status, 'success')))
    .groupBy(backups.applicationId)
    .as('last_success');
  const rows = await db
    .select({
      applicationId: backupPolicies.applicationId,
      slug: applications.slug,
      enabledSince: backupPolicies.updatedAt,
      lastSuccessAt: lastSuccess.at,
    })
    .from(backupPolicies)
    .innerJoin(applications, eq(applications.id, backupPolicies.applicationId))
    .leftJoin(lastSuccess, eq(lastSuccess.applicationId, backupPolicies.applicationId))
    .where(eq(backupPolicies.enabled, true));
  return rows.map((row) => ({
    ...row,
    lastSuccessAt: row.lastSuccessAt ? new Date(row.lastSuccessAt) : null,
  }));
}

/** Each target's last three deployments, from newest to oldest. */
export async function recentDeploymentsByTarget(
  db: Database = getDb(),
): Promise<Map<string, Array<{ status: string; createdAt: Date }>>> {
  const ranked = db
    .select({
      targetId: deployments.targetId,
      status: deployments.status,
      createdAt: deployments.createdAt,
      rank: sql<number>`row_number() over (partition by ${deployments.targetId} order by ${deployments.createdAt} desc)`.as(
        'rank',
      ),
    })
    .from(deployments)
    .where(sql`${deployments.createdAt} > now() - interval '7 days'`)
    .as('ranked');
  const rows = await db
    .select({ targetId: ranked.targetId, status: ranked.status, createdAt: ranked.createdAt })
    .from(ranked)
    .where(sql`${ranked.rank} <= 3`)
    .orderBy(asc(ranked.targetId), desc(ranked.createdAt));
  const byTarget = new Map<string, Array<{ status: string; createdAt: Date }>>();
  for (const row of rows) {
    const list = byTarget.get(row.targetId) ?? [];
    list.push({ status: row.status, createdAt: row.createdAt });
    byTarget.set(row.targetId, list);
  }
  return byTarget;
}
