import {
  HOST_SAMPLE_INTERVAL_SECONDS,
  HOST_SAMPLE_PRUNE_BATCH,
  HOST_SAMPLE_RETENTION_DAYS,
  HOST_SWEEP_BATCH,
  HOST_SWEEP_BUDGET_MS,
  HOST_SWEEP_CONCURRENCY,
  listDueTargets,
  pruneTargetSamples,
} from '@pupitre/db';
import { z } from 'zod';
import { logger } from '../logger.js';
import { getRedis } from '../redis.js';
import { collectAndRecord } from './collect.js';
import { judgeAndAnnounce } from './judge.js';
import { judgeReachability } from './reachability.js';

/**
 * The servers sweep — the clock that gives monitoring a memory.
 *
 * ── Who triggers the reading, and why it is no longer the screen ────────────
 * The screen triggered it, and that was the flaw: a history that only fills up
 * when someone looks is not a history, it is a reflection. Worse, it is empty
 * exactly when it is needed — on Monday morning, to understand what happened
 * during the weekend when nobody had the tab open.
 *
 * ── A single repeatable job, not one per machine ────────────────────────────
 * Exactly the trade-off — and the same reasons — as the site probes sweep, of
 * which this file is the twin: a repeatable job per target would be a Redis ↔
 * database reconciliation at each target created or deleted, and as many jobs
 * fighting for the queue's slots. Parallelism and time budget are decided **in a
 * single place**, and a sweep is that place.
 *
 * ── No Linux cron ───────────────────────────────────────────────────────────
 * A decision the project already settled. BullMQ is the only clock.
 *
 * ── Three guards, each necessary ────────────────────────────────────────────
 *   1. **A Redis lock**: a single sweep at a time, all workers together. It is
 *      also what replaces the probes' `next_check_at` column — see
 *      `listDueTargets()`.
 *   2. **A bounded time budget and parallelism.** Two readings in parallel, 45
 *      seconds of work. A machine turned off costs 8 seconds of SSH guard: five
 *      dead machines must not monopolize the queue.
 *   3. **The due date is the data itself**: a machine read by hand a minute ago
 *      is not due. The click is not paid for twice.
 */

/**
 * Name of the sweep job.
 *
 * Deliberately **not** in `@pupitre/core/queue.ts`, unlike `target:metrics`.
 * That contract is shared because the panel queues the job and the worker
 * consumes it. This one has only one producer and one consumer, both in this
 * process: the panel never queues it, it reads the history in SQL. Moving it to
 * the shared package would be exported vocabulary that nobody imports.
 */
export const HOST_SWEEP_JOB = 'target:metrics_sweep' as const;

/** BullMQ scheduler key. Without a colon: it is a key, not a job name. */
export const HOST_SWEEP_SCHEDULER_KEY = 'target-metrics-sweep';

const SWEEP_LOCK_KEY = 'target:metrics:sweep:lock';
const PRUNE_MARK_KEY = 'target:metrics:prune:last';

/** The purge only runs once an hour: it sweeps all machines together. */
const PRUNE_EVERY_SECONDS = 3600;

export const hostSweepJobDataSchema = z.object({
  /** Restricts the sweep to one machine. Used to trigger checks. */
  targetId: z.string().uuid().nullable().default(null),
  /** Overrides the interval: "read now, whatever happens". */
  force: z.boolean().default(false),
});

export const hostSweepJobResultSchema = z.object({
  due: z.number().int().nonnegative(),
  sampled: z.number().int().nonnegative(),
  reachable: z.number().int().nonnegative(),
  unreachable: z.number().int().nonnegative(),
  breached: z.number().int().nonnegative(),
  cleared: z.number().int().nonnegative(),
  pruned: z.number().int().nonnegative(),
  /** The sweep returned on its budget; the next one will take over. */
  budgetExhausted: z.boolean(),
  /** A sweep was already running: this occurrence did nothing, and that is normal. */
  skipped: z.boolean(),
});

export type HostSweepJobResult = z.infer<typeof hostSweepJobResultSchema>;

const EMPTY: HostSweepJobResult = {
  due: 0,
  sampled: 0,
  reachable: 0,
  unreachable: 0,
  breached: 0,
  cleared: 0,
  pruned: 0,
  budgetExhausted: false,
  skipped: false,
};

type Counters = {
  sampled: number;
  reachable: number;
  unreachable: number;
  breached: number;
  cleared: number;
};

/**
 * Reads a machine, writes, judges, and only announces the flips.
 *
 * Order matters: the reading is **written before being judged**, because the
 * crossing rule reads the series again — the consecutive readings counters are
 * not stored, they are derived. The reasoning is in `evaluateThresholds()`.
 */
async function sampleOne(target: { id: string; name: string }, counters: Counters): Promise<void> {
  const { metrics, recorded } = await collectAndRecord(target.id, 'sweep');
  counters.sampled += 1;
  if (metrics.reachable) counters.reachable += 1;
  else counters.unreachable += 1;

  if (!recorded) return;

  await judgeReachability(target);
  const verdict = await judgeAndAnnounce(target);
  counters.breached += verdict.breached;
  counters.cleared += verdict.cleared;
}

/** Runs in batches of `concurrency`, respecting a deadline. */
async function pool<T>(
  items: readonly T[],
  concurrency: number,
  deadline: number,
  run: (item: T) => Promise<void>,
): Promise<{ exhausted: boolean }> {
  let cursor = 0;
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
    }
  });

  await Promise.all(workers);
  return { exhausted };
}

/**
 * Purges retention, at most once an hour.
 *
 * The marker is in Redis and not in the database: it is a rate detail, not
 * domain data, and losing it only costs one purge too many. Copied from the
 * probes' purge, down to catching up in ten batches — an instance left a month
 * without a purge must not take a month to get back up to date.
 */
async function pruneIfDue(): Promise<number> {
  const redis = getRedis();
  const claimed = await redis.set(
    PRUNE_MARK_KEY,
    String(Date.now()),
    'EX',
    PRUNE_EVERY_SECONDS,
    'NX',
  );
  if (claimed !== 'OK') return 0;

  let total = 0;
  for (let pass = 0; pass < 10; pass += 1) {
    const removed = await pruneTargetSamples(HOST_SAMPLE_RETENTION_DAYS, HOST_SAMPLE_PRUNE_BATCH);
    total += removed;
    if (removed < HOST_SAMPLE_PRUNE_BATCH) break;
  }
  if (total > 0) {
    logger.info(
      { removed: total, retentionDays: HOST_SAMPLE_RETENTION_DAYS },
      'host readings purged',
    );
  }
  return total;
}

export type HostSweepOptions = {
  targetId?: string | null;
  force?: boolean;
};

export async function sweepHosts(options: HostSweepOptions = {}): Promise<HostSweepJobResult> {
  const single = options.targetId ?? null;
  const redis = getRedis();

  // The lock only covers the general sweep: a targeted request must succeed right
  // away, even during a sweep. It only touches one machine, and the partial unique
  // index protects the episodes anyway.
  if (single === null) {
    const lock = await redis.set(
      SWEEP_LOCK_KEY,
      String(process.pid),
      'PX',
      HOST_SWEEP_BUDGET_MS + 15_000,
      'NX',
    );
    if (lock !== 'OK') {
      logger.debug('a servers sweep is already running — occurrence ignored');
      return { ...EMPTY, skipped: true };
    }
  }

  const counters: Counters = {
    sampled: 0,
    reachable: 0,
    unreachable: 0,
    breached: 0,
    cleared: 0,
  };

  try {
    // `force` brings the interval down to zero seconds: everything is due. It is the
    // only use, and it serves the checks — never normal operation.
    const interval = options.force === true ? 0 : HOST_SAMPLE_INTERVAL_SECONDS;
    const due = await listDueTargets({
      intervalSeconds: interval,
      limit: HOST_SWEEP_BATCH,
      targetId: single,
    });

    const deadline = Date.now() + HOST_SWEEP_BUDGET_MS;
    const { exhausted } = await pool(due, HOST_SWEEP_CONCURRENCY, deadline, async (target) => {
      try {
        await sampleOne(target, counters);
      } catch (error) {
        // A machine in error does not bring down the others' sweep.
        logger.error({ err: error, targetId: target.id }, 'host reading failed');
      }
    });

    const pruned = single === null ? await pruneIfDue() : 0;

    return { due: due.length, ...counters, pruned, budgetExhausted: exhausted, skipped: false };
  } finally {
    if (single === null) await redis.del(SWEEP_LOCK_KEY).catch(() => {});
  }
}
