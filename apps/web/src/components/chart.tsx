import type { ReactNode } from 'react';
import { Tooltip } from '@/components/ui/tooltip';
import { getT } from '@/i18n/server';
import { chrome } from '@/i18n/messages/chrome';
import { formatDateTimeWith, type FormatSettings } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Pupitre's chart vocabulary — the CompCharts board.
 *
 * ── Why hand-written SVG rather than a library ──────────────────────────────
 * Recharts weighs 7.4 MB unpacked and pulls a complete state management stack;
 * Chart.js 6.2 MB, ApexCharts 21.5 MB. Above all, they all render in the browser:
 * each figure would become a client component, and a dashboard entirely rendered
 * on the server would start hydrating. The figures below are server components;
 * the SVG arrives finished in the page.
 *
 * ── Tracks on a shared axis ─────────────────────────────────────────────────
 * The kit lays the figures out as tracks: the name and what they measure in a
 * column on the left, the figure on the right, and a single time axis under the
 * stack. No vertical scale: the figure that counts is in the readouts above, and
 * each mark carries a `title` that spells it out. No text is in the SVG, which
 * stretches (`preserveAspectRatio="none"`): a `<text>` would be squashed there.
 *
 * ── The rule that governs these figures ─────────────────────────────────────
 * **A bucket without a measurement is not drawn as a zero.** It gets a pale
 * pattern, and it is counted apart. A bucket that only carries one or two
 * measurements is hatched: its rate is 0% or 100% and nothing in between, it is
 * not a value, it is a draw.
 *
 * ── Accessibility ───────────────────────────────────────────────────────────
 * The colors are the state colors, never a categorical palette; each figure is a
 * `role="img"` with a summary; a legend names the bars' tints; no value is locked
 * behind a hover alone.
 */

const VIEW = 1000;

/** Under this number of measurements, a rate is only a draw. */
const THIN_SAMPLES = 3;

export type Bucket = { at: string; samples: number };

export type Verdict = 'none' | 'sparse' | 'ok';

/**
 * Enough data to draw? `none`: nothing; `sparse`: less than a quarter of the
 * buckets covered — we draw, but we say so; `ok`: we draw.
 */
export function densityOf(buckets: readonly Bucket[]): {
  verdict: Verdict;
  covered: number;
  thin: number;
  samples: number;
} {
  let covered = 0;
  let thin = 0;
  let samples = 0;
  for (const bucket of buckets) {
    samples += bucket.samples;
    if (bucket.samples === 0) continue;
    covered += 1;
    if (bucket.samples < THIN_SAMPLES) thin += 1;
  }
  const floor = Math.max(3, Math.round(buckets.length * 0.25));
  const verdict: Verdict = covered === 0 ? 'none' : covered < floor ? 'sparse' : 'ok';
  return { verdict, covered, thin, samples };
}

function clock(iso: string, format: FormatSettings): string {
  return formatDateTimeWith(iso, format, { hour: '2-digit', minute: '2-digit' });
}

function dayClock(iso: string, format: FormatSettings): string {
  return formatDateTimeWith(iso, format, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const HATCH = 'repeating-linear-gradient(45deg, var(--surface-3) 0 3px, transparent 3px 6px)';

// ─── rate bars ────────────────────────────────────────────────────────────────

export type RatioBucket = Bucket & {
  /** "Good" measurements in the bucket (healthy probes, for instance). */
  hits: number;
};

/**
 * One bar per bucket, as high as its share of healthy measurements. Green when
 * everything is healthy, red when nothing is, amber in between; hatched under
 * `THIN_SAMPLES` measurements, pale pattern without a measurement.
 */
export async function RatioBars({
  buckets,
  height = 44,
  label,
  unit,
  format,
}: {
  /** Kept for the API: the bars are HTML, without an SVG pattern to name. */
  id?: string;
  buckets: readonly RatioBucket[];
  height?: number;
  label: string;
  unit: string;
  format: FormatSettings;
}) {
  const t = await getT(chrome);
  const density = densityOf(buckets);

  return (
    <div
      className="flex items-end gap-[3px]"
      style={{ height }}
      role="img"
      aria-label={t('chart.bars.summary', {
        label,
        covered: density.covered,
        total: buckets.length,
        samples: density.samples,
      })}
    >
      {buckets.map((bucket) => {
        if (bucket.samples === 0) {
          return (
            <i
              key={bucket.at}
              className="h-full min-w-0 flex-1 rounded-[3px] opacity-70"
              style={{ background: HATCH }}
              title={t('chart.bars.empty', { clock: clock(bucket.at, format) })}
            />
          );
        }
        const ratio = bucket.hits / bucket.samples;
        const thin = bucket.samples < THIN_SAMPLES;
        const tone = ratio === 1 ? 'var(--ok)' : ratio === 0 ? 'var(--danger)' : 'var(--warn)';
        return (
          <i
            key={bucket.at}
            className="min-w-0 flex-1 rounded-[3px]"
            style={{
              height: `${Math.max(8, ratio * 100)}%`,
              background: thin
                ? `repeating-linear-gradient(45deg, ${tone} 0 2px, color-mix(in srgb, ${tone} 25%, transparent) 2px 5px)`
                : tone,
              opacity: ratio === 1 && !thin ? 0.75 : 1,
            }}
            title={
              t('chart.bars.ratio', {
                clock: clock(bucket.at, format),
                hits: bucket.hits,
                samples: bucket.samples,
                unit,
              }) + (thin ? t('chart.bars.thin') : '')
            }
          />
        );
      })}
    </div>
  );
}

// ─── curve ────────────────────────────────────────────────────────────────────

export type SeriesBucket = Bucket & { value: number | null };

/**
 * One value per bucket, as a soft area curve, with a dot on the last measurement.
 * A bucket without a measurement cuts the curve — an average does not straddle a
 * gap — and gets a pale pattern. `threshold` draws a threshold as amber dashes.
 */
export async function SeriesLine({
  buckets,
  height = 44,
  label,
  max,
  unit = '',
  tone = 'var(--accent)',
  threshold,
  format,
}: {
  buckets: readonly SeriesBucket[];
  height?: number;
  label: string;
  max: number;
  unit?: string;
  tone?: string;
  threshold?: number;
  format: FormatSettings;
}) {
  const t = await getT(chrome);
  const count = buckets.length;
  const band = count > 0 ? VIEW / count : VIEW;
  const ceiling = Math.max(1, max);
  const padTop = 3;
  const usable = height - padTop - 1;
  const at = (index: number) => index * band + band / 2;
  const toY = (value: number) => padTop + usable - (Math.min(value, ceiling) / ceiling) * usable;

  const runs: { index: number; value: number }[][] = [];
  let run: { index: number; value: number }[] = [];
  buckets.forEach((bucket, index) => {
    if (bucket.value === null || bucket.samples === 0) {
      if (run.length > 0) runs.push(run);
      run = [];
      return;
    }
    run.push({ index, value: bucket.value });
  });
  if (run.length > 0) runs.push(run);

  const lastRun = runs[runs.length - 1];
  const lastPoint = lastRun?.[lastRun.length - 1];
  const density = densityOf(buckets);

  return (
    <div className="relative" style={{ height }}>
      <svg
        viewBox={`0 0 ${VIEW} ${height}`}
        className="block w-full overflow-visible"
        style={{ height }}
        preserveAspectRatio="none"
        role="img"
        aria-label={t('chart.series.summary', { label, covered: density.covered, total: count })}
      >
        {buckets.map((bucket, index) =>
          bucket.samples === 0 ? (
            <rect
              key={`void-${bucket.at}`}
              x={index * band}
              y={0}
              width={band}
              height={height}
              fill="var(--surface-3)"
              opacity={0.6}
            >
              <title>{t('chart.series.void', { clock: clock(bucket.at, format) })}</title>
            </rect>
          ) : null,
        )}
        {threshold !== undefined && threshold <= ceiling ? (
          <line
            x1={0}
            x2={VIEW}
            y1={toY(threshold)}
            y2={toY(threshold)}
            stroke="var(--warn)"
            strokeWidth={1}
            strokeDasharray="2 2"
            opacity={0.8}
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
        {runs.map((segment) => {
          const first = segment[0];
          const last = segment[segment.length - 1];
          if (!first || !last) return null;
          const line = segment
            .map((point, i) => `${i === 0 ? 'M' : 'L'}${at(point.index)} ${toY(point.value)}`)
            .join(' ');
          const area = `${line} L${at(last.index)} ${height} L${at(first.index)} ${height} Z`;
          return (
            <g key={`run-${first.index}`}>
              {segment.length > 1 ? <path d={area} fill={tone} opacity={0.1} /> : null}
              <path
                d={line}
                fill="none"
                stroke={tone}
                strokeWidth={1.6}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          );
        })}
        {buckets.map((bucket, index) =>
          bucket.value === null ? null : (
            <rect
              key={`hit-${bucket.at}`}
              x={index * band}
              y={0}
              width={band}
              height={height}
              fill="transparent"
            >
              <title>
                {t('chart.series.point', {
                  clock: clock(bucket.at, format),
                  value: Math.round(bucket.value),
                  unit,
                  count: bucket.samples,
                })}
              </title>
            </rect>
          ),
        )}
      </svg>
      {/* The end dot is HTML: in a stretched SVG, a circle becomes an ellipse. */}
      {lastPoint ? (
        <span
          aria-hidden
          className="pointer-events-none absolute size-[5px] rounded-full"
          style={{
            left: `calc(${(at(lastPoint.index) / VIEW) * 100}% - 2.5px)`,
            top: toY(lastPoint.value) - 2.5,
            background: tone,
          }}
        />
      ) : null}
    </div>
  );
}

// ─── events rail ──────────────────────────────────────────────────────────────

export type TimelineEvent = {
  key: string;
  at: string;
  tone: 'ok' | 'warn' | 'danger' | 'accent' | 'idle' | 'hollow';
  title: string;
};

const EVENT_COLOR: Record<TimelineEvent['tone'], string> = {
  ok: 'var(--ok)',
  warn: 'var(--warn)',
  danger: 'var(--danger)',
  accent: 'var(--accent)',
  idle: 'var(--idle)',
  hollow: 'var(--n400)',
};

/** From the most harmless to the most serious — serves to color a cluster by its worst element. */
const TONE_RANK: Record<TimelineEvent['tone'], number> = {
  hollow: 0,
  idle: 0,
  ok: 1,
  accent: 2,
  warn: 3,
  danger: 4,
};

/**
 * Two events closer than this ratio of the window merge: over 24 h, 1.2% is a
 * little more than 17 minutes.
 */
const CLUSTER_RATIO = 0.012;

/**
 * The events placed at their exact instant on a line. Each one is a chip ringed
 * in its outcome's color, with a tooltip; a cluster carries its count and takes
 * its worst member's color.
 */
export async function EventRail({
  events,
  from,
  to,
  height = 28,
  label,
}: {
  events: readonly TimelineEvent[];
  from: string;
  to: string;
  height?: number;
  label: string;
}) {
  const t = await getT(chrome);
  const start = Date.parse(from);
  const end = Date.parse(to);
  const span = Math.max(1, end - start);

  const placed = events
    .map((event) => ({ event, ratio: (Date.parse(event.at) - start) / span }))
    .filter((entry) => entry.ratio >= 0 && entry.ratio <= 1)
    .sort((a, b) => a.ratio - b.ratio);

  const clusters: { ratio: number; members: TimelineEvent[] }[] = [];
  for (const entry of placed) {
    const last = clusters[clusters.length - 1];
    if (last && entry.ratio - last.ratio <= CLUSTER_RATIO) {
      last.members.push(entry.event);
      continue;
    }
    clusters.push({ ratio: entry.ratio, members: [entry.event] });
  }

  return (
    <div
      className="relative"
      style={{ height }}
      role="group"
      aria-label={t('chart.rail.summary', { label, count: events.length })}
    >
      <span
        aria-hidden
        className="absolute inset-x-0 top-[13px] h-0.5 rounded-[1px] bg-border-subtle"
      />
      {clusters.map((cluster) => {
        const worst = cluster.members.reduce(
          (acc, member) => (TONE_RANK[member.tone] > TONE_RANK[acc] ? member.tone : acc),
          cluster.members[0]?.tone ?? 'idle',
        );
        const color = EVENT_COLOR[worst];
        const many = cluster.members.length > 1;
        const size = many ? 16 : 12;
        const title =
          cluster.members
            .slice(0, 6)
            .map((member) => member.title)
            .join('\n') +
          (cluster.members.length > 6
            ? `\n${t('chart.rail.more', { count: cluster.members.length - 6 })}`
            : '');
        return (
          <Tooltip
            key={`${cluster.ratio}-${cluster.members[0]?.key ?? ''}`}
            content={title}
            wide={many}
          >
            <span
              tabIndex={0}
              aria-label={title}
              className="absolute flex items-center justify-center rounded-full"
              style={{
                left: `${cluster.ratio * 100}%`,
                top: 14 - size / 2,
                width: size,
                height: size,
                marginLeft: -size / 2,
                background: color,
                border: '2px solid var(--surface)',
                boxShadow: `0 0 0 1px ${color}`,
              }}
            >
              {many ? (
                <span className="font-mono text-[9px] leading-none font-semibold text-surface">
                  {cluster.members.length}
                </span>
              ) : null}
            </span>
          </Tooltip>
        );
      })}
    </div>
  );
}

// ─── axis ─────────────────────────────────────────────────────────────────────

/**
 * The time axis shared by a stack of tracks, in relative time: "−24 h",
 * "−18 h"… "now". One reads a distance to the instant, not a clock time to
 * convert.
 */
export async function TimeAxis({
  from,
  to,
  ticks = 5,
}: {
  from: string;
  to: string;
  ticks?: number;
  /** Kept for the API: the relative axis no longer has a time to format. */
  format?: FormatSettings;
}) {
  const t = await getT(chrome);
  const hours = (Date.parse(to) - Date.parse(from)) / 3_600_000;
  // Beyond three days we count in whole days, one tick per day.
  const inDays = hours >= 72;
  const marks = inDays ? Math.round(hours / 24) + 1 : ticks;
  const labels = Array.from({ length: marks }, (_, index) => {
    if (index === marks - 1) return t('chart.axis.now');
    const ago = hours * (1 - index / (marks - 1));
    return inDays
      ? t('chart.axis.daysAgo', { days: Math.round(ago / 24) })
      : t('chart.axis.hoursAgo', { hours: Math.round(ago) });
  });
  return (
    <div className="axis" aria-hidden>
      {labels.map((label) => (
        <span key={label}>{label}</span>
      ))}
    </div>
  );
}

// ─── states without data ──────────────────────────────────────────────────────

/** Not enough history: we say so, and say since when we have been looking. */
export async function NotEnoughHistory({
  covered,
  buckets,
  nothing,
  since,
  format,
  children,
}: {
  covered: number;
  buckets: number;
  nothing: string;
  since?: string | null;
  format: FormatSettings;
  children?: ReactNode;
}) {
  const t = await getT(chrome);
  return (
    <div className="flex flex-col gap-1 rounded-[10px] border border-dashed border-border-strong bg-surface-2 px-3.5 py-2.5">
      <p className="t-sm text-text">{t('chart.history.title')}</p>
      <p className="t-cap text-text-3">
        {covered === 0
          ? t('chart.history.nothing', { nothing })
          : t('chart.history.covered', { count: covered, buckets }) +
            (since ? t('chart.history.oldest', { when: dayClock(since, format) }) : '.')}
      </p>
      {children}
    </div>
  );
}

// ─── small shapes ─────────────────────────────────────────────────────────────

/**
 * A resource's mini gauge: "mem ▬ 62%". Graphite at rest, amber at the
 * threshold. The figure is always written; without a measurement, a dash.
 */
export async function MiniGauge({
  value,
  label,
  warn = false,
}: {
  value: number | null;
  label: string;
  warn?: boolean;
  /** Kept for the API: the tint now follows `warn`. */
  tone?: string;
}) {
  const t = await getT(chrome);
  const measure =
    value === null
      ? t('chart.gauge.unmeasured')
      : t('chart.gauge.percent', { value: Math.round(value) });
  return (
    <span className={cn('mgauge', warn && 'is-warn')} title={`${label} — ${measure}`}>
      {label}
      <i aria-hidden>
        {value === null ? null : <b style={{ width: `${Math.max(2, Math.min(100, value))}%` }} />}
      </i>
      <span className="num">{value === null ? '—' : `${Math.round(value)}%`}</span>
    </span>
  );
}

export { MicroSpark } from './spark';
