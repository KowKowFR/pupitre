import {
  MONITOR_CAPTURE_JOB,
  MONITOR_CAPTURE_REFERENCE_SWEEP_EVERY_SECONDS,
  MONITOR_CAPTURE_RETENTION_DAYS,
  MONITOR_CHECK_RETENTION_DAYS,
  MONITOR_PRUNE_BATCH,
  MONITOR_SWEEP_BATCH,
  MONITOR_SWEEP_BUDGET_MS,
  MONITOR_SWEEP_CONCURRENCY,
  isMonitorType,
  monitorCaptureJobDataSchema,
  monitorPauseUnknownType,
  type MonitorSweepJobResult,
} from '@pupitre/core';
import { getMonitorProbe } from '@pupitre/core/probe';
import {
  applyCheck,
  claimDueMonitors,
  getMonitor,
  pruneCaptureImages,
  pruneMonitorChecks,
  suspendMonitor,
  suspendOrphanedMonitors,
  type Monitor,
  type MonitorIncident,
} from '@pupitre/db';
import { instanceLanguage } from '../language.js';
import { logger } from '../logger.js';
import { getSupervisionQueue } from '../queue.js';
import { getRedis } from '../redis.js';
import { captureEnabled } from './capture.js';
import { notifyMonitorTransition } from './notify.js';
import { allowedCidrs } from './policy.js';

/**
 * The probes sweep.
 *
 * ── What it does, and what it does not ──────────────────────────────────────
 * It observes and alerts. It redeploys nothing, restarts nothing, rolls back
 * nothing — the same rule as the scheduled tasks.
 *
 * ── The time problem, which is the real subject ─────────────────────────────
 * Fifty probes with a thirty-second timeout make twenty-five minutes if chained
 * — that is fifty sweeps stepping on each other. Three guards, each necessary:
 *
 *   1. **A Redis lock.** A single sweep at a time, all workers together. An
 *      occurrence that arrives while another works returns immediately rather
 *      than doubling the load.
 *   2. **The claim moves the due date before probing** (`claimDueMonitors`). A
 *      slow probe is therefore not picked up again by the next sweep: there are
 *      never two requests in flight toward the same site.
 *   3. **A bounded time budget and parallelism.** Ten probes in parallel,
 *      twenty-two seconds of work. What was not done stays due and goes to the
 *      next sweep — a late probe is a lesser evil than a saturated worker.
 */

const SWEEP_LOCK_KEY = 'monitor:sweep:lock';
const PRUNE_MARK_KEY = 'monitor:prune:last';
const CAPTURE_REFERENCE_MARK_KEY = 'monitor:capture:references:last';

/** The purge only runs once an hour: it sweeps all probes together. */
const PRUNE_EVERY_SECONDS = 3600;

type SweepCounters = {
  probed: number;
  healthy: number;
  unhealthy: number;
  unreachable: number;
  opened: number;
  resolved: number;
  alerts: number;
};

/**
 * Probes a probe, records, and alerts if — and only if — the state flips.
 *
 * No `if (type === 'http')` here: the sweep asks the factory for its probe and
 * talks to it through the interface, exactly as the scheduled tasks talk to the
 * drivers. That is what makes adding a kind of monitoring not touch this file.
 */
async function runOne(monitor: Monitor, counters: SweepCounters): Promise<void> {
  const before = monitor.status;

  if (!isMonitorType(monitor.type)) {
    // Code rolled back, or a row written by hand: we pause with the reason rather
    // than bring down the sweep of the forty-nine others. The reason is a key — the
    // column outlives the pause, a sentence would have frozen the language of the
    // sweep's day in it.
    await suspendMonitor(monitor.id, monitorPauseUnknownType(monitor.type));
    logger.warn({ monitorId: monitor.id, type: monitor.type }, 'unknown probe type — paused');
    return;
  }

  const result = await getMonitorProbe(monitor.type).run(monitor.config, {
    allowlist: allowedCidrs(),
    language: await instanceLanguage(),
  });

  const applied = await applyCheck(monitor, result);

  counters.probed += 1;
  counters[result.outcome] += 1;

  if (applied.transition === null) return;
  if (applied.transition === 'down') counters.opened += 1;
  if (applied.transition === 'up') counters.resolved += 1;

  if (!applied.incident) {
    // The partial unique index refused a second open incident, or there was none to
    // close. In both cases there is nothing to announce.
    logger.warn(
      { monitorId: monitor.id, transition: applied.transition },
      'transition without incident: nothing to alert',
    );
    return;
  }

  const sent = await notifyMonitorTransition(
    applied.monitor,
    before,
    applied.monitor.status,
    applied.incident,
  );
  if (sent) counters.alerts += 1;

  // **After** the alert, never before: the capture is an extra, the alert is the
  // essential. And queued, not run — see `requestIncidentCapture()`.
  requestIncidentCapture(applied.monitor.id, applied.incident, applied.transition);
}

/**
 * Asks for the page's capture for an incident that just flipped.
 *
 * `void` and not `await`: the sweep has finished its work, the incident is
 * written, the alert has gone out. Waiting for Redis's acknowledgment for an
 * image would make the critical path depend on comfort. A queuing failure is
 * logged and nothing more — a missing capture is not an incident.
 */
function requestIncidentCapture(
  monitorId: string,
  incident: MonitorIncident,
  transition: 'down' | 'up',
): void {
  if (!captureEnabled()) return;
  const data = monitorCaptureJobDataSchema.parse({
    scope: 'incident',
    monitorId,
    incidentId: incident.id,
    kind: transition === 'down' ? 'incident_open' : 'incident_resolved',
  });
  void getSupervisionQueue()
    .add(MONITOR_CAPTURE_JOB, data, { attempts: 1 })
    .catch((error: unknown) => {
      logger.warn({ err: error, monitorId, incidentId: incident.id }, 'capture not queued');
    });
}

/**
 * Queues the references refresh, at most once every five minutes.
 *
 * The marker is in Redis, like the purge's: it is a rate, not domain data, and
 * losing it only costs one pass too many. The job itself chooses *which* probes
 * need it — five at most — because that question is an SQL query, not a
 * decision of the sweep.
 */
async function requestReferenceRefresh(): Promise<void> {
  if (!captureEnabled()) return;
  const redis = getRedis();
  const claimed = await redis.set(
    CAPTURE_REFERENCE_MARK_KEY,
    String(Date.now()),
    'EX',
    MONITOR_CAPTURE_REFERENCE_SWEEP_EVERY_SECONDS,
    'NX',
  );
  if (claimed !== 'OK') return;
  await getSupervisionQueue().add(
    MONITOR_CAPTURE_JOB,
    monitorCaptureJobDataSchema.parse({ scope: 'references' }),
    { attempts: 1 },
  );
}

/** Runs `tasks` in batches of `concurrency`, respecting a deadline. */
async function pool<T>(
  items: readonly T[],
  concurrency: number,
  deadline: number,
  run: (item: T) => Promise<void>,
): Promise<{ done: number; exhausted: boolean }> {
  let cursor = 0;
  let done = 0;
  let exhausted = false;

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      if (Date.now() >= deadline) {
        exhausted = true;
        return;
      }
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) return;
      await run(item);
      done += 1;
    }
  });

  await Promise.all(workers);
  return { done, exhausted };
}

/**
 * Purges retention, at most once an hour.
 *
 * The marker is in Redis and not in the database: it is a rate detail, not
 * domain data, and losing it only costs one purge too many.
 */
async function pruneIfDue(): Promise<number> {
  const redis = getRedis();
  const claimed = await redis.set(PRUNE_MARK_KEY, String(Date.now()), 'EX', PRUNE_EVERY_SECONDS, 'NX');
  if (claimed !== 'OK') return 0;

  let total = 0;
  // Several batches in a row at the first pass: an instance left without a purge
  // for a month must not take a month to catch up.
  for (let pass = 0; pass < 10; pass += 1) {
    const removed = await pruneMonitorChecks(MONITOR_CHECK_RETENTION_DAYS, MONITOR_PRUNE_BATCH);
    total += removed;
    if (removed < MONITOR_PRUNE_BATCH) break;
  }
  if (total > 0) {
    logger.info(
      { removed: total, retentionDays: MONITOR_CHECK_RETENTION_DAYS },
      'monitoring measurements purged',
    );
  }

  /**
   * Same time slot for the captures' bytes — but we **take the bytes back without
   * deleting the row**: incidents are never purged, and a timeline that says
   * "image purged on …" is better than a silently truncated one. Counted apart from
   * `pruned`, which counts measurements.
   */
  let images = 0;
  for (let pass = 0; pass < 10; pass += 1) {
    const purged = await pruneCaptureImages(MONITOR_CAPTURE_RETENTION_DAYS);
    images += purged;
    if (purged === 0) break;
  }
  if (images > 0) {
    logger.info(
      { purged: images, retentionDays: MONITOR_CAPTURE_RETENTION_DAYS },
      'capture bytes taken back by retention',
    );
  }

  return total;
}

export type SweepOptions = {
  /** Restricts the sweep to one probe. */
  monitorId?: string | null;
  /** Overrides the due date: "probe now". */
  force?: boolean;
};

const EMPTY: MonitorSweepJobResult = {
  claimed: 0,
  probed: 0,
  healthy: 0,
  unhealthy: 0,
  unreachable: 0,
  opened: 0,
  resolved: 0,
  alerts: 0,
  suspended: 0,
  pruned: 0,
  budgetExhausted: false,
};

export async function sweepMonitors(options: SweepOptions = {}): Promise<MonitorSweepJobResult> {
  const single = options.monitorId ?? null;
  const redis = getRedis();

  // The lock only covers the general sweep. A "probe now" request on a precise
  // probe must succeed right away, even if a sweep is running: it only touches one
  // row, already claimed.
  if (single === null) {
    const lock = await redis.set(
      SWEEP_LOCK_KEY,
      String(process.pid),
      'PX',
      MONITOR_SWEEP_BUDGET_MS + 10_000,
      'NX',
    );
    if (lock !== 'OK') {
      logger.debug('a monitoring sweep is already running — occurrence ignored');
      return EMPTY;
    }
  }

  const counters: SweepCounters = {
    probed: 0,
    healthy: 0,
    unhealthy: 0,
    unreachable: 0,
    opened: 0,
    resolved: 0,
    alerts: 0,
  };

  try {
    // A destroyed application must not trigger an outage alert: the worst false
    // positive, the one that teaches ignoring alerts.
    const suspended = single === null ? await suspendOrphanedMonitors() : 0;

    let due: Monitor[];
    if (single !== null) {
      const row = await getMonitor(single);
      due = row && (options.force === true || row.enabled) ? [row] : [];
    } else {
      due = await claimDueMonitors(MONITOR_SWEEP_BATCH);
    }

    const deadline = Date.now() + MONITOR_SWEEP_BUDGET_MS;
    const { exhausted } = await pool(due, MONITOR_SWEEP_CONCURRENCY, deadline, async (monitor) => {
      try {
        await runOne(monitor, counters);
      } catch (error) {
        // A probe in error does not bring the sweep down: the forty-nine others must go
        // through.
        logger.error({ err: error, monitorId: monitor.id }, 'monitoring probe failed');
      }
    });

    const pruned = single === null ? await pruneIfDue() : 0;

    if (single === null) {
      // The "before" references: queued, never taken here. A queuing failure must not
      // fail a sweep that did its work.
      await requestReferenceRefresh().catch((error: unknown) => {
        logger.warn({ err: error }, 'references refresh not queued');
      });
    }

    return { claimed: due.length, ...counters, suspended, pruned, budgetExhausted: exhausted };
  } finally {
    if (single === null) await redis.del(SWEEP_LOCK_KEY).catch(() => {});
  }
}
