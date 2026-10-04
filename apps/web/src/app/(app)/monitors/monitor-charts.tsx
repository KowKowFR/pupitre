'use client';

import * as React from 'react';
import { useT } from '@/i18n/client';
import { monitors as messages } from '@/i18n/messages/monitors';
import { formatDateTimeWith, type FormatSettings } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * The two figures of monitoring.
 *
 * A reading choice, and it is worth writing down: the colors used here are the
 * panel's **state colors** (`--ok`, `--warn`, `--danger`), never a categorical
 * palette. They mean good/bad, not "series 1 / series 2", and they serve no other
 * purpose in the screen.
 *
 * The state is therefore never carried by color alone:
 *   — each bar of the strip carries a tooltip that names its verdict;
 *   — a legend names the three colors under the strip;
 *   — the `HealthDot` indicator and the figure next to it say the same thing
 *     again in words;
 *   — and a probe's detail contains the complete table of measurements, which is
 *     the equivalent readable without color.
 *
 * No value is locked behind a hover.
 */

export type OutcomePoint = {
  at: string;
  latencyMs: number | null;
  outcome: string;
};

/**
 * A point's time, in the instance's locale.
 *
 * The components — day, month, hour, minute — are imposed by the figure: an axis
 * does not have room for a complete date. The **locale**, on the other hand, is
 * not: it comes from `settings.locale`, as is (`fr-FR`, `en-GB`, `en-US`), and
 * comes down through props as everywhere else. The shortcut of before —
 * `language === 'fr' ? 'fr-FR' : 'en-GB'` — gave British dates to an instance set
 * to `en-US`, and ignored the setting it had made.
 *
 * The time zone is **not** imposed here: doing so would move the displayed time
 * on any instance whose process does not already run in the instance's time zone
 * — and this project's containers run in UTC. It is a rendering change, not a
 * translation; it belongs to another commit.
 */
function formatClock(iso: string, format: FormatSettings): string {
  return formatDateTimeWith(iso, format, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ─── verdicts strip ───────────────────────────────────────────────────────────

/** Each verdict's `.strip` class: green by default, then amber, red, gray. */
const STRIP_CLASS: Record<string, string> = {
  healthy: '',
  unhealthy: 'w',
  unreachable: 'd',
  unknown: 'n',
};

/**
 * One bar per measurement, from the oldest to the most recent.
 *
 * Two pixels of background between the bars, never a border: it is the
 * background that separates, not a line. A strip without a measurement does not
 * show — it would say "all is well" about nothing.
 */
export function OutcomeStrip({
  points,
  format,
  className,
  height = 22,
}: {
  points: readonly OutcomePoint[];
  /** The instance's locale and time zone. Through props: the server and the client
   *  must read the same value, otherwise hydration diverges. */
  format: FormatSettings;
  className?: string;
  height?: number;
}) {
  const t = useT(messages);
  if (points.length === 0) return null;

  const outcomeLabel = (outcome: string): string =>
    outcome === 'healthy' ||
    outcome === 'unhealthy' ||
    outcome === 'unreachable' ||
    outcome === 'unknown'
      ? t(`outcome.${outcome}`)
      : outcome;

  return (
    <div
      className={cn('strip', className)}
      style={{ height }}
      role="img"
      aria-label={t('chart.strip.label', { count: points.length })}
    >
      {points.map((point) => (
        <i
          key={point.at}
          className={STRIP_CLASS[point.outcome] ?? 'n'}
          title={
            point.latencyMs === null
              ? t('chart.point.title', {
                  clock: formatClock(point.at, format),
                  outcome: outcomeLabel(point.outcome),
                })
              : t('chart.point.titleWithLatency', {
                  clock: formatClock(point.at, format),
                  outcome: outcomeLabel(point.outcome),
                  latency: point.latencyMs,
                })
          }
        />
      ))}
    </div>
  );
}

/** The axis under a strip: the first pass on the left, now on the right. */
export function StripAxis({
  points,
  format,
  ticks = 2,
}: {
  points: readonly OutcomePoint[];
  format: FormatSettings;
  /** Number of ticks, ends included. */
  ticks?: number;
}) {
  const t = useT(messages);
  if (points.length === 0) return null;
  const labels = Array.from({ length: ticks }, (_, index) => {
    if (index === ticks - 1) return t('axis.now');
    const point = points[Math.round((index / (ticks - 1)) * (points.length - 1))];
    return point ? clockOf(point.at, format) : '';
  });
  return (
    <div className="axis" aria-hidden>
      {labels.map((label, index) => (
        <span key={index}>{label}</span>
      ))}
    </div>
  );
}

function clockOf(iso: string, format: FormatSettings): string {
  return formatDateTimeWith(iso, format, { hour: '2-digit', minute: '2-digit' });
}

// ─── latency curve ────────────────────────────────────────────────────────────

type Plotted = { x: number; y: number; point: OutcomePoint };

function buildGeometry(
  points: readonly OutcomePoint[],
  width: number,
  height: number,
  padTop: number,
  padBottom: number,
): { plotted: Plotted[]; gaps: number[]; max: number; step: number } {
  const step = points.length > 1 ? width / (points.length - 1) : 0;
  const values = points
    .map((point) => point.latencyMs)
    .filter((value): value is number => value !== null);
  // A 1 ms floor avoids a flattened curve on a very fast probe.
  const max = Math.max(1, ...values);
  const usable = height - padTop - padBottom;

  const plotted: Plotted[] = [];
  const gaps: number[] = [];

  points.forEach((point, index) => {
    const x = points.length > 1 ? index * step : width / 2;
    if (point.latencyMs === null) {
      gaps.push(x);
      return;
    }
    plotted.push({ x, y: padTop + usable - (point.latencyMs / max) * usable, point });
  });

  return { plotted, gaps, max, step };
}

/** Splits into continuous segments: a measurement without latency cuts the line. */
function segmentsOf(points: readonly OutcomePoint[], plotted: Plotted[]): Plotted[][] {
  const byAt = new Map(plotted.map((entry) => [entry.point.at, entry]));
  const runs: Plotted[][] = [];
  let current: Plotted[] = [];
  for (const point of points) {
    const entry = byAt.get(point.at);
    if (entry) {
      current.push(entry);
    } else if (current.length > 0) {
      runs.push(current);
      current = [];
    }
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

/**
 * A compact curve of the recent latencies — a single series, hence no legend: the
 * column names it. A pale area under the line, like the panel's other curves.
 *
 * The measurements without latency — nothing answered — cut the line. A line
 * joining both sides of an outage would tell a continuity that did not happen.
 */
export function LatencySparkline({
  points,
  width = 150,
  height = 30,
  tone = 'var(--accent)',
  className,
}: {
  points: readonly OutcomePoint[];
  width?: number;
  height?: number;
  /** The line's tint: ultramarine, or danger when the probe is down. */
  tone?: string;
  className?: string;
}) {
  const t = useT(messages);
  const usable = points.filter((point) => point.latencyMs !== null);
  if (usable.length === 0) return null;

  const padTop = 3;
  const padBottom = 1;
  const { plotted } = buildGeometry(points, width, height, padTop, padBottom);
  const runs = segmentsOf(points, plotted);

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn('overflow-visible', className)}
      role="img"
      aria-label={t('chart.sparkline.label', { count: points.length })}
    >
      {runs.map((run) => {
        const line = run
          .map((entry, index) => `${index === 0 ? 'M' : 'L'}${entry.x} ${entry.y}`)
          .join(' ');
        const first = run[0];
        const last = run.at(-1);
        return (
          <g key={first?.point.at ?? 'run'}>
            {first && last ? (
              <path
                d={`${line} L${last.x} ${height} L${first.x} ${height} Z`}
                fill={tone}
                opacity={0.1}
              />
            ) : null}
            <path
              d={line}
              fill="none"
              stroke={tone}
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </g>
        );
      })}
    </svg>
  );
}

// ─── detailed curve, with crosshair ───────────────────────────────────────────

/**
 * The same series, large, with a crosshair on hover.
 *
 * No y-axis: the hovered value shows plainly, and the measurements table, lower
 * on the screen, contains all the values. The measurements without an answer
 * group into hatched red bands, edged with a dotted line.
 */
export function LatencyChart({
  points,
  format,
  height = 120,
  className,
}: {
  points: readonly OutcomePoint[];
  format: FormatSettings;
  height?: number;
  className?: string;
}) {
  const t = useT(messages);
  const [hover, setHover] = React.useState<number | null>(null);
  const width = 1000;
  const padTop = 8;
  const padBottom = 2;

  const usable = points.filter((point) => point.latencyMs !== null);
  if (points.length === 0 || usable.length === 0) return null;

  const { plotted, step } = buildGeometry(points, width, height, padTop, padBottom);
  const runs = segmentsOf(points, plotted);

  // Consecutive gaps become a single band, from the gap to the next one.
  const bands: Array<{ from: number; to: number }> = [];
  points.forEach((point, index) => {
    if (point.latencyMs !== null) return;
    const x = points.length > 1 ? index * step : width / 2;
    const previous = bands.at(-1);
    if (previous && Math.abs(previous.to - (x - step)) < 0.5) previous.to = x;
    else bands.push({ from: x, to: x });
  });

  const active = hover === null ? null : (plotted[hover] ?? null);
  const ticks = [0, 1 / 3, 2 / 3, 1].map(
    (ratio) => points[Math.round(ratio * (points.length - 1))],
  );

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="relative">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          className="block w-full"
          style={{ height }}
          role="img"
          aria-label={t('chart.latency.label')}
          onMouseLeave={() => setHover(null)}
          onMouseMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const x = ((event.clientX - rect.left) / rect.width) * width;
            if (plotted.length === 0) return;
            let nearest = 0;
            let best = Number.POSITIVE_INFINITY;
            plotted.forEach((entry, index) => {
              const distance = Math.abs(entry.x - x);
              if (distance < best) {
                best = distance;
                nearest = index;
              }
            });
            setHover(nearest);
          }}
        >
          <defs>
            <pattern
              id="latency-gap"
              width="9"
              height="9"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(0)"
            >
              <rect width="6" height="9" fill="var(--danger)" opacity="0.14" />
            </pattern>
          </defs>
          {bands.map((band) => (
            <g key={band.from}>
              <rect
                x={band.from - step / 2}
                y={0}
                width={Math.max(3, band.to - band.from + step)}
                height={height}
                fill="url(#latency-gap)"
              />
              <line
                x1={band.from - step / 2}
                x2={band.from - step / 2}
                y1={0}
                y2={height}
                stroke="var(--danger)"
                strokeDasharray="3 3"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          ))}
          {runs.map((run) => {
            const line = run
              .map((entry, index) => `${index === 0 ? 'M' : 'L'}${entry.x} ${entry.y}`)
              .join(' ');
            const first = run[0];
            const last = run.at(-1);
            return (
              <g key={first?.point.at ?? 'run'}>
                {first && last ? (
                  <path
                    d={`${line} L${last.x} ${height} L${first.x} ${height} Z`}
                    fill="var(--accent)"
                    opacity={0.1}
                  />
                ) : null}
                <path
                  d={line}
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth={1.6}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            );
          })}
          {active ? (
            <line
              x1={active.x}
              x2={active.x}
              y1={0}
              y2={height}
              stroke="var(--border-strong)"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
        </svg>
        {active ? (
          <>
            <span
              aria-hidden
              className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface bg-accent"
              style={{ left: `${(active.x / width) * 100}%`, top: active.y }}
            />
            <div className="pointer-events-none absolute top-0 right-0 rounded-md border border-border bg-surface px-2 py-1 text-[11px] shadow-sm">
              <div className="mono text-text">{active.point.latencyMs} ms</div>
              <div className="text-text-3">{formatClock(active.point.at, format)}</div>
            </div>
          </>
        ) : null}
      </div>
      <div className="axis" aria-hidden>
        {ticks.map((point, index) => (
          <span key={index}>{point ? clockOf(point.at, format) : ''}</span>
        ))}
      </div>
    </div>
  );
}
