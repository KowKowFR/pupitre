import {
  DEFAULT_UI_LANGUAGE,
  MONITOR_CHECK_RETENTION_DAYS,
  MONITOR_PRUNE_BATCH,
  translator,
  type HostMetrics,
  type UiLanguage,
} from '@pupitre/core';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type Database } from './client.js';
import { targets } from './schema/infra.js';
import {
  targetMetricBreaches,
  targetMetricSamples,
  targetMetricThresholds,
} from './schema/target-metrics.js';

/**
 * Server monitoring's memory — writing, reading, thresholds.
 *
 * ── Where the decision lives ────────────────────────────────────────────────
 * In this project, what decides lives in `@pupitre/core` and this module writes
 * (see the header of `monitors.ts`). The catalog and the crossing rule below
 * should therefore be in `@pupitre/core/host-metrics.ts`, next to the reading
 * types they comment on. They are here because `packages/core` was out of scope
 * for this work — four others were running in parallel. **It is a debt, and it
 * is named**: the move is a cut and paste, these functions are pure and touch
 * neither `getDb()` nor Drizzle.
 */

// ─── interval and retention ───────────────────────────────────────────────────

/**
 * One reading every 5 minutes per machine.
 *
 * **Why not every minute.** One minute on five machines for thirty days is
 * 216,000 rows for information nobody reads to the second: a disk does not go
 * from 40% to 90% in sixty seconds, and neither does memory. Five minutes bring
 * the volume down to ~8,600 rows per machine per month — three times less than a
 * site probe every minute, which this panel already writes without anybody
 * worrying.
 *
 * **Why it is not blind for all that.** The only metric that moves fast is the
 * load. That is exactly why the reading records the *three* averages: `load15`
 * covers the last fifteen minutes, hence the four minutes we do not look at. A
 * spike invisible on `load1` stays readable on the next reading's `load15`.
 *
 * **Why not an adjustable interval per machine either.** It would be a fourth
 * button to understand for zero gain: unlike a site probe — whose interval costs
 * a third party and depends on what it observes — an SSH reading only costs us,
 * and every machine observes the same thing.
 */
export const HOST_SAMPLE_INTERVAL_SECONDS = 300;

/**
 * Retention of the series, in days. **Exactly that of the site probes**, and not
 * by chance: two different retentions in the same panel would force the
 * operator to remember two figures and wonder which applies to what they look
 * at. The constant is derived, not copied — moving one moves the other.
 */
export const HOST_SAMPLE_RETENTION_DAYS = MONITOR_CHECK_RETENTION_DAYS;

/** Size of a purge batch. Same value, same reason: not to hold the table. */
export const HOST_SAMPLE_PRUNE_BATCH = MONITOR_PRUNE_BATCH;

/**
 * Machines read by one sweep. Generous: a reading takes ~1 s on a machine that
 * answers, and the sweep's time budget already bounds the rest.
 */
export const HOST_SWEEP_BATCH = 50;

/** Readings run in parallel. Two: the same caution as the screen, for the same reason. */
export const HOST_SWEEP_CONCURRENCY = 2;

/**
 * Time budget of a sweep. Under the install interval (60 s): what was not read
 * stays due and goes to the next sweep.
 */
export const HOST_SWEEP_BUDGET_MS = 45_000;

/**
 * Install interval of the sweep. Five times finer than the reading interval: it
 * is what lets an added machine be read quickly.
 */
export const HOST_SWEEP_EVERY_MS = 60_000;

// ─── the catalog of monitored metrics ─────────────────────────────────────────

export const HOST_METRIC_KEYS = ['disk', 'memory', 'load'] as const;
export type HostMetricKey = (typeof HOST_METRIC_KEYS)[number];
export const hostMetricKeySchema = z.enum(HOST_METRIC_KEYS);

export function isHostMetricKey(value: string): value is HostMetricKey {
  return (HOST_METRIC_KEYS as readonly string[]).includes(value);
}

export type HostMetricDefinition = {
  key: HostMetricKey;
  /** The metric's name, in the requested language (French by default). */
  label: (language?: UiLanguage) => string;
  /**
   * Default threshold, as a percentage. **These are the values the screen already
   * shows in red** (`host-readouts.tsx`, `saturationTone`): the alert threshold
   * does not make up a second vocabulary next to the color.
   */
  defaultLimitPercent: number;
  /** Consecutive readings above before opening. Specific to the metric. */
  defaultBreachSamples: number;
  /** Consecutive readings below before closing. */
  defaultClearSamples: number;
  /** Extracts from the row the value comparable to the threshold. `null` = not measured. */
  read: (sample: TargetMetricSample) => number | null;
  /** A crossing sentence, for the log and for the screen. */
  describe: (value: number, sample: TargetMetricSample, language?: UiLanguage) => string;
};

const hostMetricCopy = {
  fr: {
    'disk.label': 'Disque',
    'memory.label': 'Mémoire',
    'load.label': 'Charge',
    'disk.describe': 'disque {path} à {value} %',
    'memory.describe': 'mémoire utilisée à {value} %',
    'load.describe': 'charge à {perCore} par cœur{detail}',
    'load.detail': ' ({load} sur {cores} cœurs)',
  },
  en: {
    'disk.label': 'Disk',
    'memory.label': 'Memory',
    'load.label': 'Load',
    'disk.describe': 'disk {path} at {value}%',
    'memory.describe': 'memory used at {value}%',
    'load.describe': 'load at {perCore} per core{detail}',
    'load.detail': ' ({load} on {cores} cores)',
  },
} as const;

const metricSay = (language: UiLanguage = DEFAULT_UI_LANGUAGE) =>
  translator(hostMetricCopy, language);

/**
 * The three monitored dimensions, and the setting that goes with them.
 *
 * **The number of consecutive readings is not the same everywhere, and it is
 * the heart of the setting.** A disk is a slow and monotonic quantity: a single
 * reading above 90% is already the truth, requiring three confirmations would
 * only delay the alert by a quarter of an hour. A load, on the contrary, is
 * noise: an isolated spike at 4 on an 11-core machine means nothing, and has no
 * reason to wake anyone up. Three readings in a row above capacity, however, is
 * a machine in trouble.
 *
 * Adding a dimension (I/O, number of processes, temperature) = one entry here
 * and one column in the table. Nothing else to change: neither the sweep, nor
 * the screen, nor the routes.
 */
export const HOST_METRIC_CATALOG: Record<HostMetricKey, HostMetricDefinition> = {
  disk: {
    key: 'disk',
    label: (language) => metricSay(language)('disk.label'),
    defaultLimitPercent: 90,
    // A single reading is enough: the disk does not bounce.
    defaultBreachSamples: 1,
    defaultClearSamples: 2,
    read: (sample) => sample.diskPercent,
    describe: (value, sample, language) =>
      metricSay(language)('disk.describe', {
        path: sample.diskPath ?? '',
        value: value.toFixed(1),
      }).replace('  ', ' '),
  },
  memory: {
    key: 'memory',
    label: (language) => metricSay(language)('memory.label'),
    defaultLimitPercent: 90,
    // Two: a momentary memory spike is common, two readings five minutes apart are
    // not.
    defaultBreachSamples: 2,
    defaultClearSamples: 2,
    read: (sample) => sample.memoryPercent,
    describe: (value, _sample, language) =>
      metricSay(language)('memory.describe', { value: value.toFixed(1) }),
  },
  load: {
    key: 'load',
    label: (language) => metricSay(language)('load.label'),
    // 100% = one full core per core. It is the value beyond which the screen already
    // shows the load in red.
    defaultLimitPercent: 100,
    defaultBreachSamples: 3,
    defaultClearSamples: 3,
    read: (sample) => sample.loadPercent,
    describe: (value, sample, language) =>
      metricSay(language)('load.describe', {
        perCore: (value / 100).toFixed(2),
        detail:
          sample.cores === null
            ? ''
            : metricSay(language)('load.detail', {
                load: sample.loadOne?.toFixed(2) ?? '?',
                cores: sample.cores,
              }),
      }),
  },
};

export const HOST_METRIC_LIST: readonly HostMetricDefinition[] = HOST_METRIC_KEYS.map(
  (key) => HOST_METRIC_CATALOG[key],
);

// ─── types ────────────────────────────────────────────────────────────────────

export type TargetMetricSample = typeof targetMetricSamples.$inferSelect;
export type TargetMetricBreach = typeof targetMetricBreaches.$inferSelect;
export type TargetMetricThresholdRow = typeof targetMetricThresholds.$inferSelect;

/** Where a reading comes from. A manual "Read now" counts as much as a sweep. */
export const sampleSourceSchema = z.enum(['sweep', 'manual']);
export type SampleSource = z.infer<typeof sampleSourceSchema>;

/** An effective threshold, and where it comes from. The screen must be able to say it. */
export type ResolvedThreshold = {
  metric: HostMetricKey;
  limitPercent: number;
  breachSamples: number;
  clearSamples: number;
  enabled: boolean;
  /** `default` = the catalog, `global` = the instance row, `target` = the machine. */
  origin: 'default' | 'global' | 'target';
};

/** A flip: the only moment something is said to the outside. */
export type BreachTransition = {
  kind: 'opened' | 'cleared';
  metric: HostMetricKey;
  breach: TargetMetricBreach;
  threshold: ResolvedThreshold;
  value: number;
  /** Filled in when the episode closes because the threshold was disabled. */
  reason: 'crossed' | 'threshold_disabled';
};

// ─── writing a reading ────────────────────────────────────────────────────────

/**
 * Records a reading.
 *
 * **Every reading is recorded, whatever triggered it.** The sweep and the
 * screen's "Read now" button write the same row, with `source` as the only
 * difference. That is what makes a click no longer a wasted expense: the SSH
 * session was paid for, the value stays.
 *
 * An unreachable machine produces a row too — `reachable = false`, the reason,
 * no metric. A gap in a timeline does not say whether there was an outage or no
 * monitor.
 */
export async function recordTargetSample(
  metrics: HostMetrics,
  source: SampleSource = 'sweep',
  db: Database = getDb(),
): Promise<TargetMetricSample> {
  const load = metrics.load;
  const memory = metrics.memory;
  const disk = metrics.disk;

  const [row] = await db
    .insert(targetMetricSamples)
    .values({
      targetId: metrics.targetId,
      sampledAt: new Date(metrics.checkedAt),
      source,
      reachable: metrics.reachable,
      latencyMs: metrics.latencyMs,
      error: metrics.error,
      loadOne: load?.one ?? null,
      loadFive: load?.five ?? null,
      loadFifteen: load?.fifteen ?? null,
      cores: load?.cores ?? null,
      // `perCore` is already `null` when `nproc` is missing: we do not assume one core.
      loadPercent: load?.perCore === null || load?.perCore === undefined ? null : load.perCore * 100,
      memoryTotalKb: memory?.totalKb ?? null,
      memoryUsedKb: memory?.usedKb ?? null,
      memoryPercent: memory?.usedPercent ?? null,
      diskPath: disk?.path ?? null,
      diskSizeKb: disk?.sizeKb ?? null,
      diskUsedKb: disk?.usedKb ?? null,
      diskPercent: disk?.usePercent ?? null,
      uptimeSeconds: metrics.uptimeSeconds === null ? null : Math.round(metrics.uptimeSeconds),
    })
    .returning();
  if (!row) throw new Error('reading insert returned nothing');
  return row;
}

// ─── seuils ───────────────────────────────────────────────────────────────────

export const upsertThresholdSchema = z.object({
  metric: hostMetricKeySchema,
  limitPercent: z.number().positive().max(1000),
  breachSamples: z.number().int().min(1).max(10).optional(),
  clearSamples: z.number().int().min(1).max(10).optional(),
  enabled: z.boolean().optional(),
});
export type UpsertThresholdInput = z.infer<typeof upsertThresholdSchema>;

/**
 * A machine's effective threshold, metric by metric.
 *
 * Three layers, from weakest to strongest: the catalog (always present, so a new
 * instance alerts without anything having been set), the global row
 * (`target_id is null`), then the machine's row. The resolution is done **here
 * and nowhere else** — a `?? default` copied into the screen and into the sweep
 * would be two truths that would end up diverging.
 */
export async function resolveThresholds(
  targetId: string,
  db: Database = getDb(),
): Promise<Record<HostMetricKey, ResolvedThreshold>> {
  const rows = await db
    .select()
    .from(targetMetricThresholds)
    .where(
      sql`${targetMetricThresholds.targetId} is null or ${targetMetricThresholds.targetId} = ${targetId}`,
    );

  const out = {} as Record<HostMetricKey, ResolvedThreshold>;
  for (const definition of HOST_METRIC_LIST) {
    out[definition.key] = {
      metric: definition.key,
      limitPercent: definition.defaultLimitPercent,
      breachSamples: definition.defaultBreachSamples,
      clearSamples: definition.defaultClearSamples,
      enabled: true,
      origin: 'default',
    };
  }

  // Global first, machine next: the second overwrites the first.
  for (const scope of ['global', 'target'] as const) {
    for (const row of rows) {
      if (!isHostMetricKey(row.metric)) continue;
      const isGlobal = row.targetId === null;
      if ((scope === 'global') !== isGlobal) continue;
      out[row.metric] = {
        metric: row.metric,
        limitPercent: row.limitPercent,
        breachSamples: row.breachSamples,
        clearSamples: row.clearSamples,
        enabled: row.enabled,
        origin: scope,
      };
    }
  }
  return out;
}

/** The explicit thresholds in the database, as is. Used by the settings screen. */
export async function listThresholdRows(
  db: Database = getDb(),
): Promise<TargetMetricThresholdRow[]> {
  return db.select().from(targetMetricThresholds);
}

/**
 * Sets or replaces a threshold. `targetId = null` sets the instance's default.
 *
 * `onConflictDoUpdate` on the partial unique index: two simultaneous settings of
 * the same metric cannot create two competing rows.
 */
export async function upsertThreshold(
  targetId: string | null,
  input: UpsertThresholdInput,
  updatedBy: string | null,
  db: Database = getDb(),
): Promise<TargetMetricThresholdRow> {
  const definition = HOST_METRIC_CATALOG[input.metric];
  const values = {
    targetId,
    metric: input.metric,
    limitPercent: input.limitPercent,
    breachSamples: input.breachSamples ?? definition.defaultBreachSamples,
    clearSamples: input.clearSamples ?? definition.defaultClearSamples,
    enabled: input.enabled ?? true,
    updatedBy,
    updatedAt: new Date(),
  };

  const [row] = await db
    .insert(targetMetricThresholds)
    .values(values)
    .onConflictDoUpdate({
      // The targeted index depends on the scope: both indexes are partial, and
      // Postgres requires the index's predicate to be satisfied by the row.
      target:
        targetId === null
          ? [targetMetricThresholds.metric]
          : [targetMetricThresholds.targetId, targetMetricThresholds.metric],
      targetWhere:
        targetId === null
          ? sql`${targetMetricThresholds.targetId} is null`
          : sql`${targetMetricThresholds.targetId} is not null`,
      set: {
        limitPercent: values.limitPercent,
        breachSamples: values.breachSamples,
        clearSamples: values.clearSamples,
        enabled: values.enabled,
        updatedBy,
        updatedAt: values.updatedAt,
      },
    })
    .returning();
  if (!row) throw new Error('threshold write returned nothing');
  return row;
}

/** Removes a setting: the layer below takes over. */
export async function deleteThreshold(
  targetId: string | null,
  metric: HostMetricKey,
  db: Database = getDb(),
): Promise<boolean> {
  const [row] = await db
    .delete(targetMetricThresholds)
    .where(
      and(
        eq(targetMetricThresholds.metric, metric),
        targetId === null
          ? isNull(targetMetricThresholds.targetId)
          : eq(targetMetricThresholds.targetId, targetId),
      ),
    )
    .returning({ id: targetMetricThresholds.id });
  return row !== undefined;
}

// ─── the crossing rule ────────────────────────────────────────────────────────

/**
 * How many readings must be read back to decide, all thresholds together.
 * Bounded by the table's constraints (`between 1 and 10`), and taken generously:
 * an unreachable reading does not count, so margin is needed.
 */
const RECENT_WINDOW = 40;

/**
 * Decides, from the last readings, whether a threshold is crossed or released.
 *
 * ── Why the counters are not stored ─────────────────────────────────────────
 * Site monitoring keeps `consecutive_failures` on the probe's row. Here, they are
 * **read back from the series** at each evaluation. Two reasons:
 *
 *   1. the series already exists and it is indexed by `(target_id, sampled_at)`;
 *      a counter would be a second truth, which a worker killed at the wrong
 *      moment would make diverge from the first;
 *   2. lowering a threshold must produce the alert **right away** if the machine
 *      is already above, not in fifteen minutes. A stored counter would have
 *      been reset by the change of setting.
 *
 * The `monitor_incidents` objection — "an incident is a decision taken at an
 * instant, with that instant's settings, it must be immutable" — is about the
 * **episode**, not the counters. It is honored: the episode is a row, and it
 * copies the threshold that opened it.
 *
 * ── A reading that measured nothing does not count ──────────────────────────
 * Machine off, `df` missing: the value is `null`. It counts neither as a
 * crossing nor as a return to normal — it is **skipped**. Counting it as a
 * return to normal would close by itself the episode of a machine whose full
 * disk may be the cause of the outage.
 */
export function decideBreach(
  values: readonly (number | null)[],
  threshold: ResolvedThreshold,
  hasOpenBreach: boolean,
): 'open' | 'clear' | null {
  const measured = values.filter((value): value is number => value !== null);

  if (!hasOpenBreach) {
    if (measured.length < threshold.breachSamples) return null;
    const streak = measured.slice(0, threshold.breachSamples);
    return streak.every((value) => value > threshold.limitPercent) ? 'open' : null;
  }

  if (measured.length < threshold.clearSamples) return null;
  const streak = measured.slice(0, threshold.clearSamples);
  return streak.every((value) => value <= threshold.limitPercent) ? 'clear' : null;
}

/**
 * Applies the rule to a reading just written, and returns the flips.
 *
 * Everything fits in a transaction: without it, a worker killed between opening
 * the episode and reading it would leave a crossing nobody would be warned
 * about — exactly `applyCheck()`'s argument for probes.
 *
 * **This function neither alerts nor audits.** It observes. It is the caller
 * (the worker) that writes the audit entry, as `notifyMonitorTransition()` does
 * for probes: a single place in the project where a transition becomes a
 * message.
 */
export async function evaluateThresholds(
  targetId: string,
  db: Database = getDb(),
): Promise<BreachTransition[]> {
  const thresholds = await resolveThresholds(targetId, db);

  return db.transaction(async (tx) => {
    const recent = await tx
      .select()
      .from(targetMetricSamples)
      .where(eq(targetMetricSamples.targetId, targetId))
      .orderBy(desc(targetMetricSamples.sampledAt))
      .limit(RECENT_WINDOW);

    if (recent.length === 0) return [];
    const latest = recent[0] as TargetMetricSample;

    const open = await tx
      .select()
      .from(targetMetricBreaches)
      .where(
        and(
          eq(targetMetricBreaches.targetId, targetId),
          isNull(targetMetricBreaches.resolvedAt),
        ),
      );
    const openByMetric = new Map(open.map((row) => [row.metric, row]));

    const transitions: BreachTransition[] = [];
    const now = latest.sampledAt;

    for (const definition of HOST_METRIC_LIST) {
      const threshold = thresholds[definition.key];
      const current = openByMetric.get(definition.key) ?? null;
      const values = recent.map((sample) => definition.read(sample));
      const value = values[0] ?? null;

      // Threshold disabled: we no longer judge, but we do not leave an episode open
      // forever — it closes, and the log says why.
      if (!threshold.enabled) {
        if (current) {
          const [closed] = await tx
            .update(targetMetricBreaches)
            .set({ resolvedAt: now })
            .where(eq(targetMetricBreaches.id, current.id))
            .returning();
          if (closed) {
            transitions.push({
              kind: 'cleared',
              metric: definition.key,
              breach: closed,
              threshold,
              value: closed.lastValue,
              reason: 'threshold_disabled',
            });
          }
        }
        continue;
      }

      // The open episode follows the metric even without a flip: that is where we
      // learn "92% at worst, for 3 h" — without writing an audit line.
      if (current && value !== null) {
        await tx
          .update(targetMetricBreaches)
          .set({
            lastValue: value,
            peakValue: Math.max(current.peakValue, value),
            samples: current.samples + 1,
          })
          .where(eq(targetMetricBreaches.id, current.id));
      }

      const verdict = decideBreach(values, threshold, current !== null);
      if (verdict === null) continue;

      if (verdict === 'open' && value !== null) {
        // `onConflictDoNothing` relies on the partial unique index: even if the sweep
        // and a manual "Read now" concluded at the same time, there would be only one
        // episode, hence only one audit entry.
        const [opened] = await tx
          .insert(targetMetricBreaches)
          .values({
            targetId,
            metric: definition.key,
            startedAt: now,
            limitPercent: threshold.limitPercent,
            openedValue: value,
            peakValue: value,
            lastValue: value,
            samples: 1,
          })
          .onConflictDoNothing()
          .returning();
        if (opened) {
          transitions.push({
            kind: 'opened',
            metric: definition.key,
            breach: opened,
            threshold,
            value,
            reason: 'crossed',
          });
        }
        continue;
      }

      if (verdict === 'clear' && current) {
        const [closed] = await tx
          .update(targetMetricBreaches)
          .set({ resolvedAt: now, lastValue: value ?? current.lastValue })
          .where(eq(targetMetricBreaches.id, current.id))
          .returning();
        if (closed) {
          transitions.push({
            kind: 'cleared',
            metric: definition.key,
            breach: closed,
            threshold,
            value: value ?? closed.lastValue,
            reason: 'crossed',
          });
        }
      }
    }

    return transitions;
  });
}

// ─── reachability ─────────────────────────────────────────────────────────────

/**
 * Readings missed in a row before declaring a machine unreachable. Two, and not
 * one: a reboot, a cut of a few seconds wake nobody up. At the sweep's interval,
 * it is five to ten minutes of silence.
 */
export const UNREACHABLE_CONFIRM_SAMPLES = 2;

export type ReachabilityTransition =
  | { kind: 'unreachable'; since: Date; at: Date; failures: number; error: string | null }
  | { kind: 'reachable'; since: Date; at: Date };

/**
 * Applies the reachability rule to the reading just written, and returns the
 * flip if there is one.
 *
 * The episode lives on the machine (`targets.unreachable_since`): it opens at
 * the second reading missed in a row, dated from the first, and closes at the
 * first successful reading. The machine's row is locked while deciding: a sweep
 * and a "Read now" concluding in the same second only make one flip, hence one
 * alert.
 *
 * Like `evaluateThresholds()`, it observes and does not audit: it is the worker
 * that turns the flip into a message.
 */
export async function evaluateReachability(
  targetId: string,
  db: Database = getDb(),
): Promise<ReachabilityTransition | null> {
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select({ since: targets.unreachableSince })
      .from(targets)
      .where(eq(targets.id, targetId))
      .for('update');
    if (!target) return null;

    const recent = await tx
      .select({
        reachable: targetMetricSamples.reachable,
        error: targetMetricSamples.error,
        sampledAt: targetMetricSamples.sampledAt,
      })
      .from(targetMetricSamples)
      .where(eq(targetMetricSamples.targetId, targetId))
      .orderBy(desc(targetMetricSamples.sampledAt))
      .limit(UNREACHABLE_CONFIRM_SAMPLES);
    const latest = recent[0];
    if (!latest) return null;

    if (latest.reachable) {
      if (!target.since) return null;
      await tx.update(targets).set({ unreachableSince: null }).where(eq(targets.id, targetId));
      return { kind: 'reachable', since: target.since, at: latest.sampledAt };
    }

    if (target.since) return null;
    if (recent.length < UNREACHABLE_CONFIRM_SAMPLES) return null;
    if (recent.some((sample) => sample.reachable)) return null;
    const since = recent[recent.length - 1]!.sampledAt;
    await tx.update(targets).set({ unreachableSince: since }).where(eq(targets.id, targetId));
    return {
      kind: 'unreachable',
      since,
      at: latest.sampledAt,
      failures: recent.length,
      error: latest.error,
    };
  });
}

// ─── balayage ─────────────────────────────────────────────────────────────────

/**
 * The machines whose last reading is older than the interval.
 *
 * **No due-date column on `targets`.** Site monitoring has one (`next_check_at`)
 * because several workers claim probes concurrently and must move the due date
 * *before* probing. Here, a Redis lock guarantees a single sweep at a time, and
 * the last reading's date is already in the series: a column would be a second
 * truth, which would diverge the day a reading is written without going through
 * the sweep — which is precisely what the "Read now" button does.
 *
 * A desirable side effect: a manual click naturally pushes back that machine's
 * sweep. Two readings three seconds apart teach nothing.
 */
export async function listDueTargets(
  options: {
    intervalSeconds?: number;
    limit?: number;
    /**
     * Restricted to one machine. The filter is **in** the query, not after:
     * filtering a batch of 50 would miss a machine due in 51st position.
     */
    targetId?: string | null;
  } = {},
  db: Database = getDb(),
): Promise<Array<{ id: string; name: string; lastSampleAt: Date | null }>> {
  const intervalSeconds = options.intervalSeconds ?? HOST_SAMPLE_INTERVAL_SECONDS;
  const limit = options.limit ?? HOST_SWEEP_BATCH;
  const only = options.targetId ?? null;

  const last = db
    .select({
      targetId: targetMetricSamples.targetId,
      lastSampleAt: sql<Date | null>`max(${targetMetricSamples.sampledAt})`.as('last_sample_at'),
    })
    .from(targetMetricSamples)
    .groupBy(targetMetricSamples.targetId)
    .as('last');

  const rows = await db
    .select({ id: targets.id, name: targets.name, lastSampleAt: last.lastSampleAt })
    .from(targets)
    .leftJoin(last, eq(last.targetId, targets.id))
    .where(
      and(
        sql`${last.lastSampleAt} is null or ${last.lastSampleAt} <= now() - make_interval(secs => ${intervalSeconds})`,
        only === null ? undefined : eq(targets.id, only),
      ),
    )
    // Never-read ones first: a machine just declared must appear on screen with a
    // past, not wait its turn.
    .orderBy(sql`${last.lastSampleAt} asc nulls first`)
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    lastSampleAt: row.lastSampleAt === null ? null : new Date(row.lastSampleAt),
  }));
}

/**
 * Purges the series beyond retention, in batches.
 *
 * **Crossings are never purged**: they are rare, they tell the story, and a
 * truncated timeline is worth nothing. The same trade-off as probe incidents.
 */
export async function pruneTargetSamples(
  days: number = HOST_SAMPLE_RETENTION_DAYS,
  batch: number = HOST_SAMPLE_PRUNE_BATCH,
  db: Database = getDb(),
): Promise<number> {
  const rows = await db
    .delete(targetMetricSamples)
    .where(
      sql`${targetMetricSamples.id} in (
        select id from ${targetMetricSamples}
         where sampled_at < now() - make_interval(days => ${days})
         limit ${batch}
      )`,
    )
    .returning({ id: targetMetricSamples.id });
  return rows.length;
}

// ─── screen reads ─────────────────────────────────────────────────────────────

/** A point of the curve: a time interval, and the **worst** of its readings. */
export type HistoryPoint = {
  at: string;
  samples: number;
  reachable: number;
  diskPercent: number | null;
  memoryPercent: number | null;
  loadPercent: number | null;
};

export type MetricSummary = {
  /** Last known value of the window. */
  last: number | null;
  /** The worst reading of the window — the question one really asks. */
  worst: number | null;
  /** Last value minus the first: the direction it is going. */
  trend: number | null;
};

export type TargetHistory = {
  targetId: string;
  hours: number;
  bucketSeconds: number;
  /** Number of readings really taken in the window. A rate without a denominator lies. */
  samples: number;
  /** Readings where the machine answered. */
  reachable: number;
  points: HistoryPoint[];
  summary: Record<HostMetricKey, MetricSummary>;
};

const EMPTY_SUMMARY: MetricSummary = { last: null, worst: null, trend: null };

function summarise(points: readonly HistoryPoint[], key: HostMetricKey): MetricSummary {
  const field =
    key === 'disk' ? 'diskPercent' : key === 'memory' ? 'memoryPercent' : 'loadPercent';
  const values = points
    .map((point) => point[field])
    .filter((value): value is number => value !== null);
  if (values.length === 0) return EMPTY_SUMMARY;
  const first = values[0] as number;
  const last = values[values.length - 1] as number;
  return { last, worst: Math.max(...values), trend: last - first };
}

/**
 * The history of several machines, aggregated **at read time**.
 *
 * ── Why no pre-aggregation table ────────────────────────────────────────────
 * Seven days at five minutes make 2,016 points per machine: unreadable on a
 * 120-pixel curve, and useless to carry. The usual answer is a table of hourly
 * rollups. It is not taken here: it would require a second write, a second
 * purge and a consistency story between the two, to fit a `max()` on a few
 * thousand rows already indexed by `(target_id, sampled_at)`. Postgres
 * aggregates that without breaking a sweat. The day the fleet makes this
 * computation expensive, the rollups table goes *on top of* the raw series
 * without changing anything to what writes it.
 *
 * ── Why `max()` and not `avg()` ─────────────────────────────────────────────
 * We are looking at saturation. An average over thirty minutes drowns exactly
 * the moment of interest — the 100% spike that brought the application down. The
 * interval's worst reading is the only honest aggregation for that question.
 */
export async function targetHistories(
  targetIds: readonly string[],
  hours: number,
  buckets = 48,
  db: Database = getDb(),
): Promise<Map<string, TargetHistory>> {
  const bucketSeconds = Math.max(60, Math.round((hours * 3600) / buckets));
  const out = new Map<string, TargetHistory>();

  for (const id of targetIds) {
    out.set(id, {
      targetId: id,
      hours,
      bucketSeconds,
      samples: 0,
      reachable: 0,
      points: [],
      summary: { disk: EMPTY_SUMMARY, memory: EMPTY_SUMMARY, load: EMPTY_SUMMARY },
    });
  }
  if (targetIds.length === 0) return out;

  // The bucket is expressed in epoch seconds: no time zone goes into the
  // computation, and two machines share exactly the same bounds.
  //
  // `sql.raw` and not a bound parameter, and it is not a shortcut: the same
  // expression appears in the SELECT, the GROUP BY and the ORDER BY. Bound, it
  // would produce `$1`, `$5` and `$7` — three placeholders Postgres cannot
  // recognize as a single expression, and it refuses the query ("column
  // sampled_at must appear in the GROUP BY clause"). The bug existed. No
  // injection possible: `bucketSeconds` is the result of a `Math.round` on
  // integers already validated by Zod, never a string.
  const seconds = sql.raw(String(bucketSeconds));
  const bucket = sql<string>`to_timestamp(floor(extract(epoch from ${targetMetricSamples.sampledAt}) / ${seconds}) * ${seconds})`;

  const rows = await db
    .select({
      targetId: targetMetricSamples.targetId,
      at: bucket,
      samples: sql<number>`count(*)::int`,
      reachable: sql<number>`count(*) filter (where ${targetMetricSamples.reachable})::int`,
      diskPercent: sql<number | null>`max(${targetMetricSamples.diskPercent})`,
      memoryPercent: sql<number | null>`max(${targetMetricSamples.memoryPercent})`,
      loadPercent: sql<number | null>`max(${targetMetricSamples.loadPercent})`,
    })
    .from(targetMetricSamples)
    .where(
      and(
        inArray(targetMetricSamples.targetId, [...targetIds]),
        sql`${targetMetricSamples.sampledAt} >= now() - make_interval(hours => ${hours})`,
      ),
    )
    .groupBy(targetMetricSamples.targetId, bucket)
    .orderBy(asc(bucket));

  for (const row of rows) {
    const history = out.get(row.targetId);
    if (!history) continue;
    history.points.push({
      at: new Date(row.at).toISOString(),
      samples: row.samples,
      reachable: row.reachable,
      diskPercent: row.diskPercent,
      memoryPercent: row.memoryPercent,
      loadPercent: row.loadPercent,
    });
    history.samples += row.samples;
    history.reachable += row.reachable;
  }

  for (const history of out.values()) {
    history.summary = {
      disk: summarise(history.points, 'disk'),
      memory: summarise(history.points, 'memory'),
      load: summarise(history.points, 'load'),
    };
  }

  return out;
}

/** The ongoing crossings, all machines or one. */
export async function listOpenBreaches(
  targetIds?: readonly string[],
  db: Database = getDb(),
): Promise<TargetMetricBreach[]> {
  const where =
    targetIds === undefined
      ? isNull(targetMetricBreaches.resolvedAt)
      : and(
          isNull(targetMetricBreaches.resolvedAt),
          inArray(targetMetricBreaches.targetId, [...targetIds]),
        );
  if (targetIds !== undefined && targetIds.length === 0) return [];
  return db
    .select()
    .from(targetMetricBreaches)
    .where(where)
    .orderBy(desc(targetMetricBreaches.startedAt));
}

/** The timeline of a machine's crossings, open and closed. */
export async function listBreaches(
  targetId: string,
  limit = 50,
  db: Database = getDb(),
): Promise<TargetMetricBreach[]> {
  return db
    .select()
    .from(targetMetricBreaches)
    .where(eq(targetMetricBreaches.targetId, targetId))
    .orderBy(desc(targetMetricBreaches.startedAt))
    .limit(limit);
}

/** A machine's last raw readings. Used for the detail and as proof. */
export async function listTargetSamples(
  targetId: string,
  limit = 100,
  db: Database = getDb(),
): Promise<TargetMetricSample[]> {
  return db
    .select()
    .from(targetMetricSamples)
    .where(eq(targetMetricSamples.targetId, targetId))
    .orderBy(desc(targetMetricSamples.sampledAt))
    .limit(limit);
}
