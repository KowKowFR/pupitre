import {
  forecastBackup,
  forecastCertificate,
  forecastDeploys,
  forecastDisk,
  forecastFlapping,
  forecastLatency,
  forecastLoad,
  forecastMemory,
  type Forecast,
  type SeriesPoint,
} from '@pupitre/core';
import {
  backupFreshness,
  listMonitors,
  listRoutes,
  listTargets,
  logAudit,
  monitorForecastWindows,
  recentDeploymentsByTarget,
  resolveThresholds,
  syncForecasts,
  targetHourlySeries,
  type ForecastRow,
} from '@pupitre/db';
import type { Job } from 'bullmq';
import { logger } from '../logger.js';
import { getRedis } from '../redis.js';

/**
 * The forecasts sweep: every 30 minutes, it reads again the series the database
 * already keeps and draws from them what is going to break — a disk filling up,
 * a leaking memory, a rising load, a probe slowing down or flipping, a
 * certificate nobody renewed, a backup that no longer runs, deployments failing
 * one after the other.
 *
 * The computation is in `@pupitre/core/forecast` (pure, tested). Here: read,
 * call, match the episodes. **Only an episode's opening and closing are written
 * to the log** (`forecast.raised`, `forecast.cleared`) — it is the opening that
 * goes out as a notification, once, not at each sweep.
 *
 * Like the other sweeps: no database row for the clock, a Redis lock so that
 * only one runs at a time.
 */

/** Job name. A single producer and a single consumer, here: it stays local. */
export const FORECAST_SWEEP_JOB = 'forecast:sweep' as const;
/** BullMQ scheduler key — without a colon. */
export const FORECAST_SWEEP_SCHEDULER_KEY = 'forecast-sweep';
export const FORECAST_SWEEP_EVERY_MS = 30 * 60_000;

const LOCK_KEY = 'forecast:sweep:lock';
const LOCK_MS = 10 * 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export type ForecastSweepResult = {
  skipped: boolean;
  found: number;
  opened: number;
  cleared: number;
};

/**
 * From hourly averages to daily averages: the load breathes every day, the trend
 * reads from one day to the next.
 */
function dailyMeans(points: readonly SeriesPoint[]): SeriesPoint[] {
  const days = new Map<number, { sum: number; count: number }>();
  for (const point of points) {
    const day = Math.floor(point.t / DAY_MS) * DAY_MS;
    const entry = days.get(day) ?? { sum: 0, count: 0 };
    entry.sum += point.v;
    entry.count += 1;
    days.set(day, entry);
  }
  return (
    [...days.entries()]
      // A barely measured day does not tell its average.
      .filter(([, entry]) => entry.count >= 6)
      .map(([t, entry]) => ({ t: t + DAY_MS / 2, v: entry.sum / entry.count }))
  );
}

/** Everything the sweep observes at instant `now`. */
export async function collectForecasts(now: number = Date.now()): Promise<Forecast[]> {
  const [targets, monitors, routes, windows, freshness, deploys] = await Promise.all([
    listTargets(),
    listMonitors(),
    listRoutes({}),
    monitorForecastWindows(),
    backupFreshness(),
    recentDeploymentsByTarget(),
  ]);
  const found: Forecast[] = [];
  const push = (forecast: Forecast | null) => {
    if (forecast) found.push(forecast);
  };

  for (const target of targets) {
    const subject = { type: 'target' as const, id: target.id, name: target.name };
    const [series, thresholds] = await Promise.all([
      targetHourlySeries(target.id, 7),
      resolveThresholds(target.id),
    ]);
    const sizeGib = series.diskSizeKb === null ? null : series.diskSizeKb / 1024 / 1024;
    push(forecastDisk(subject, series.disk, now, sizeGib));
    // Memory: the last three days only — a leak shows quickly, and a restart a week
    // ago has nothing to say about today's slope.
    push(
      forecastMemory(
        subject,
        series.memory.filter((point) => now - point.t <= 3 * DAY_MS),
        now,
      ),
    );
    push(forecastLoad(subject, dailyMeans(series.load), thresholds.load.limitPercent, now));
    push(
      forecastDeploys(
        subject,
        (deploys.get(target.id) ?? []).map((entry) => ({
          status: entry.status,
          createdAt: entry.createdAt.toISOString(),
        })),
        now,
      ),
    );
  }

  for (const monitor of monitors) {
    // A paused probe no longer measures anything: it no longer forecasts anything
    // either.
    if (!monitor.enabled) continue;
    const window = windows.get(monitor.id);
    if (!window) continue;
    const subject = { type: 'monitor' as const, id: monitor.id, name: monitor.name };
    push(forecastLatency(subject, window));
    push(forecastFlapping(subject, window.flips));
  }

  for (const route of routes) {
    if (!route.tls || route.certificate?.status !== 'valid') continue;
    push(
      forecastCertificate(
        { type: 'route', id: route.id, name: route.hostname },
        route.certificate.notAfter,
        now,
      ),
    );
  }

  for (const entry of freshness) {
    push(
      forecastBackup(
        { type: 'application', id: entry.applicationId, name: entry.slug },
        entry.lastSuccessAt?.toISOString() ?? null,
        entry.enabledSince.toISOString(),
        now,
      ),
    );
  }

  return found;
}

function auditPayload(row: ForecastRow) {
  return {
    kind: row.kind,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    subjectName: row.subjectName,
    severity: row.severity,
    etaAt: row.etaAt?.toISOString() ?? null,
    detail: row.detail,
  };
}

export async function sweepForecasts(now: number = Date.now()): Promise<ForecastSweepResult> {
  const redis = getRedis();
  const lock = await redis.set(LOCK_KEY, String(process.pid), 'PX', LOCK_MS, 'NX');
  if (lock !== 'OK') return { skipped: true, found: 0, opened: 0, cleared: 0 };
  try {
    const found = await collectForecasts(now);
    const { opened, cleared } = await syncForecasts(found, new Date(now));
    for (const row of opened) {
      await logAudit({
        actorId: null,
        action: 'forecast.raised',
        resourceType: 'forecast',
        resourceId: row.id,
        after: auditPayload(row),
      });
    }
    for (const row of cleared) {
      await logAudit({
        actorId: null,
        action: 'forecast.cleared',
        resourceType: 'forecast',
        resourceId: row.id,
        after: auditPayload(row),
      });
    }
    return { skipped: false, found: found.length, opened: opened.length, cleared: cleared.length };
  } finally {
    await redis.del(LOCK_KEY).catch(() => {});
  }
}

export async function handleForecastSweep(job: Job): Promise<ForecastSweepResult> {
  const result = await sweepForecasts();
  // A sweep without a change is the normal case: it is not written.
  if (result.opened > 0 || result.cleared > 0) {
    logger.info({ jobId: job.id, ...result }, 'forecasts sweep completed');
  }
  return result;
}
