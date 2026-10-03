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
 * Le balayage des prévisions : toutes les 30 minutes, il relit les séries que
 * la base garde déjà et en tire ce qui va casser — un disque qui se remplit,
 * une mémoire qui fuit, une charge qui monte, une sonde qui ralentit ou qui
 * bascule, un certificat que personne n'a renouvelé, une sauvegarde qui ne
 * tourne plus, des déploiements qui échouent en série.
 *
 * Le calcul est dans `@pupitre/core/forecast` (pur, testé). Ici : lire,
 * appeler, accorder les épisodes. **Seuls l'ouverture et la fermeture d'un
 * épisode s'écrivent au journal** (`forecast.raised`, `forecast.cleared`) —
 * c'est l'ouverture qui part en notification, une fois, pas à chaque balayage.
 *
 * Comme les autres balayages : pas de ligne en base pour l'horloge, un verrou
 * Redis pour qu'un seul tourne à la fois.
 */

/** Nom de la tâche. Un seul producteur et un seul consommateur, ici : il reste local. */
export const FORECAST_SWEEP_JOB = 'forecast:sweep' as const;
/** Clé du scheduler BullMQ — sans deux-points. */
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

/** Des moyennes horaires aux moyennes journalières : la charge respire chaque jour, la tendance se lit d'un jour à l'autre. */
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
      // Un jour mesuré à peine ne dit pas sa moyenne.
      .filter(([, entry]) => entry.count >= 6)
      .map(([t, entry]) => ({ t: t + DAY_MS / 2, v: entry.sum / entry.count }))
  );
}

/** Tout ce que le balayage constate à l'instant `now`. */
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
    // La mémoire : les trois derniers jours seulement — une fuite se voit vite,
    // et un redémarrage d'il y a une semaine n'a rien à dire de la pente d'aujourd'hui.
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
    // Une sonde suspendue ne mesure plus rien : elle ne prévoit plus rien non plus.
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
  // Un balayage sans changement est le cas normal : il ne s'écrit pas.
  if (result.opened > 0 || result.cleared > 0) {
    logger.info({ jobId: job.id, ...result }, 'balayage des prévisions terminé');
  }
  return result;
}
