'use client';

import { useCallback, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { Translate } from '@pupitre/core';
import { Led, type Tone } from '@/components/instrument';
import { Alert } from '@/components/ui/alert';
import { SegmentedControl } from '@/components/ui/segmented';
import { useT } from '@/i18n/client';
import { servers } from '@/i18n/messages/servers';
import { formatDateTimeWith, type FormatSettings } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * A server's past, under its readings.
 *
 * ── Why a figure alone says nothing ─────────────────────────────────────────
 * "Disk: 89%" does not read. 89% after six months at 88% is a well-sized server;
 * 89% after a week at 11% is a leak that will fill the partition before Friday.
 * The same figure, two opposite situations. Three things lift the ambiguity, and
 * all three are shown:
 *
 *   1. **the shape** — the strip, which shows where it comes from;
 *   2. **the window's worst reading** — the question one really asks when
 *      arriving on Monday morning: "did it hit the ceiling over the weekend?".
 *      The last value cannot answer it;
 *   3. **the trend** — the direction and the extent, in percentage points.
 *
 * ── Why the threshold is *drawn*, not only written ──────────────────────────
 * A dashed line across the strip turns "89% against a threshold at 90" into an
 * image: the bars that go past the line are the problem, they are counted at a
 * glance. The bars are neutral, only a breach takes the danger color — and it
 * stays readable in grayscale, through the bar's position on the line and the
 * figure written beside it.
 *
 * ── Why the history shows even with the machine off ─────────────────────────
 * It comes from the database, not from the machine. It is written in the
 * `metrics/history` route: at the precise moment the instant reading has nothing
 * to say, the curve of the last 24 h is what one came looking for.
 */

export type HistoryMetric = 'disk' | 'memory' | 'load';

export type HistoryPointView = {
  at: string;
  samples: number;
  reachable: number;
  diskPercent: number | null;
  memoryPercent: number | null;
  loadPercent: number | null;
};

export type MetricSummaryView = {
  last: number | null;
  worst: number | null;
  trend: number | null;
};

export type ThresholdView = {
  limitPercent: number;
  enabled: boolean;
  origin: 'default' | 'global' | 'target';
};

export type BreachView = {
  id: string;
  metric: string;
  startedAt: string;
  limitPercent: number;
  peakValue: number;
  lastValue: number;
  samples: number;
};

export type HostHistoryData = {
  hours: number;
  samples: number;
  reachable: number;
  points: HistoryPointView[];
  summary: Record<HistoryMetric, MetricSummaryView>;
  thresholds: Record<HistoryMetric, ThresholdView>;
  breaches: BreachView[];
};

type T = Translate<typeof servers.fr>;

const METRIC_KEY: Record<HistoryMetric, keyof typeof servers.fr> = {
  disk: 'metric.disk',
  memory: 'metric.memory',
  load: 'metric.load',
};

/** The name of a metric unknown to the catalog stays raw: it is an identifier. */
function metricLabel(metric: string, t: T): string {
  const key = METRIC_KEY[metric as HistoryMetric] as keyof typeof servers.fr | undefined;
  return key === undefined ? metric : t(key);
}

const METRIC_FIELD: Record<HistoryMetric, keyof HistoryPointView> = {
  disk: 'diskPercent',
  memory: 'memoryPercent',
  load: 'loadPercent',
};

const METRICS: readonly HistoryMetric[] = ['disk', 'memory', 'load'];

/**
 * A value's tint, **relative to its threshold**.
 *
 * The adjustable threshold became the only reference number: the screen's red
 * and the audit line that wakes someone up now speak of the same figure. Before,
 * the screen turned red at a hard-coded 90% while an alert could have been set
 * elsewhere — two vocabularies for a single question.
 */
export function toneFor(value: number | null, limit: number, enabled: boolean): Tone {
  if (value === null) return 'idle';
  if (!enabled) return 'idle';
  if (value > limit) return 'danger';
  // 85% of the threshold: early enough to act, late enough not to cry wolf.
  if (value > limit * 0.85) return 'warn';
  return 'ok';
}

function formatPercent(value: number | null, t: T): string {
  if (value === null) return '—';
  return t('percent', { value: value.toFixed(value < 10 ? 1 : 0) });
}

/** The load reads better "per core" than as a percentage of capacity. */
function formatValue(metric: HistoryMetric, value: number | null, t: T): string {
  if (value === null) return '—';
  if (metric === 'load') return `${(value / 100).toFixed(2)}`;
  return formatPercent(value, t);
}

/**
 * An interval's instant, in a bar's tooltip.
 *
 * The components are imposed by the room — `13/09 00:33` fits in a `title`, a
 * long date does not. The locale, for its part, comes from the instance settings
 * and comes down through props: this component is a client one, and `13/09
 * 00:33` on an English panel reads backwards every other day.
 */
function formatClock(iso: string, format: FormatSettings): string {
  return formatDateTimeWith(iso, format, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function sinceLabel(iso: string, t: T): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 3600) {
    return t('breach.since.minutes', { count: Math.max(1, Math.floor(seconds / 60)) });
  }
  if (seconds < 86_400) return t('breach.since.hours', { count: Math.floor(seconds / 3600) });
  return t('breach.since.days', { count: Math.floor(seconds / 86_400) });
}

/**
 * The trend over the window, in percentage points: "stable", "+6 pt".
 *
 * Under one point, there is no trend: there is noise. Announcing "+0.3 pt" would
 * suggest a movement.
 */
export function trendText(trend: number | null, t: T): string {
  if (trend === null || Math.abs(trend) < 1) return t('trend.stable');
  return `${trend > 0 ? '+' : '−'}${t('trend.points', { value: Math.abs(trend).toFixed(0) })}`;
}

/** Hatching for an interval without a measurement — the same pattern as the other strips. */
const HATCH = 'repeating-linear-gradient(45deg, var(--surface-3) 0 3px, transparent 3px 6px)';

/**
 * A metric's strip: one bar per interval, the interval's **worst reading**, and
 * the threshold across.
 *
 * The worst and not the average: we look at a saturation. A thirty-minute
 * average drowns exactly the peak we are looking for.
 */
function Spark({
  metric,
  points,
  limit,
  enabled,
  format,
  height = 24,
}: {
  metric: HistoryMetric;
  points: readonly HistoryPointView[];
  limit: number;
  enabled: boolean;
  format: FormatSettings;
  height?: number;
}) {
  const t = useT(servers);
  const field = METRIC_FIELD[metric];
  const values = points.map((point) => point[field] as number | null);
  const measured = values.filter((value): value is number => value !== null);
  if (measured.length === 0) return <div className="flex-1" style={{ height }} />;

  // The scale rises above 100 when the load exceeds the capacity, and always keeps
  // the threshold visible in the frame.
  const ceiling = Math.max(100, limit * 1.1, ...measured);
  const limitY = height - (limit / ceiling) * height;

  return (
    <div
      className="relative min-w-0 flex-1"
      style={{ height }}
      role="img"
      aria-label={t('spark.aria', {
        metric: metricLabel(metric, t),
        count: points.length,
      })}
    >
      <div className="absolute inset-0 flex items-end gap-px">
        {points.map((point, index) => {
          const value = values[index] ?? null;
          if (value === null) {
            // No usable reading in this interval: hatching, not a bar at zero. Zero would
            // mean "empty disk".
            return (
              <i
                key={point.at}
                title={t('spark.empty', { clock: formatClock(point.at, format) })}
                className="h-full min-w-[2px] flex-1 rounded-[2px] opacity-70"
                style={{ background: HATCH }}
              />
            );
          }
          const over = enabled && value > limit;
          return (
            <i
              key={point.at}
              title={t('spark.point', {
                clock: formatClock(point.at, format),
                value: formatPercent(value, t),
                over: over ? t('spark.over', { limit }) : '',
              })}
              className={cn(
                'min-w-[2px] flex-1 rounded-t-[2px]',
                over ? 'bg-danger' : 'opacity-45',
              )}
              style={{
                height: Math.max(2, (value / ceiling) * height),
                background: over ? undefined : 'var(--gauge-fill)',
              }}
            />
          );
        })}
      </div>
      {enabled ? (
        <span
          aria-hidden
          className="pointer-events-none absolute right-0 left-0 border-t border-dashed border-text-3"
          style={{ top: Math.max(0, limitY) }}
          title={t('spark.limit', { limit })}
        />
      ) : null}
    </div>
  );
}

function MetricLine({
  metric,
  data,
  format,
}: {
  metric: HistoryMetric;
  data: HostHistoryData;
  format: FormatSettings;
}) {
  const t = useT(servers);
  const summary = data.summary[metric];
  const threshold = data.thresholds[metric];
  const tone = toneFor(summary.worst, threshold.limitPercent, threshold.enabled);
  // The load reads "per core"; so does its trend, not in points.
  const trend =
    metric === 'load' && summary.trend !== null && Math.abs(summary.trend) >= 1
      ? `${summary.trend > 0 ? '+' : '−'}${(Math.abs(summary.trend) / 100).toFixed(2)}`
      : trendText(summary.trend, t);

  return (
    <div className="flex items-center gap-3">
      <span className="flex w-24 shrink-0 items-center gap-2 text-[12.5px] font-medium text-text-2">
        <Led tone={tone} />
        {metricLabel(metric, t)}
      </span>

      <Spark
        metric={metric}
        points={data.points}
        limit={threshold.limitPercent}
        enabled={threshold.enabled}
        format={format}
      />

      <span className="mono flex w-[15rem] shrink-0 items-center justify-end gap-3 text-[11.5px] tabular-nums max-sm:hidden">
        <span className="text-text-3">
          {t('metric.worst')}{' '}
          <span className={cn('font-medium', tone === 'danger' ? 'text-danger-text' : 'text-text')}>
            {formatValue(metric, summary.worst, t)}
          </span>
        </span>
        <span className="text-text-2">{trend}</span>
        <span
          className="text-text-3"
          title={
            threshold.origin === 'target'
              ? t('threshold.from.target')
              : threshold.origin === 'global'
                ? t('threshold.from.global')
                : t('threshold.from.default')
          }
        >
          {threshold.enabled
            ? t('threshold.value', {
                value: formatValue(metric, threshold.limitPercent, t),
              })
            : t('threshold.off')}
          {threshold.origin === 'default' ? '' : ' *'}
        </span>
      </span>
    </div>
  );
}

/**
 * The ongoing breaches, under the readings band. One box per breach: the metric,
 * since when, the value and the worst.
 */
export function OpenBreaches({ breaches }: { breaches: readonly BreachView[] }) {
  const t = useT(servers);
  if (breaches.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 border-t border-border-subtle px-4 py-2.5">
      {breaches.map((breach) => (
        <Alert key={breach.id} variant="warn">
          {t('breach.line', {
            metric: metricLabel(breach.metric, t),
            limit: breach.limitPercent,
            since: sinceLabel(breach.startedAt, t),
            last: formatPercent(breach.lastValue, t),
            peak: formatPercent(breach.peakValue, t),
            samples: t('breach.samples', { count: breach.samples }),
          })}
        </Alert>
      ))}
    </div>
  );
}

/**
 * The history folds under the readings band: the band answers "how is it
 * doing", the strip "since when". It opens on its own when the second question
 * is the one being asked — unreachable machine, threshold crossed.
 *
 * A native `<details>` and not an `aria-expanded` disclosure: it costs no state,
 * and the screen's contract reserves `aria-expanded` for a server's list of
 * applications.
 */
export function HostHistory({
  targetId,
  initial,
  format,
  defaultOpen = false,
}: {
  targetId: string;
  initial: HostHistoryData;
  /** Formatting comes down through props: the strip is a client one, the locale is not. */
  format: FormatSettings;
  defaultOpen?: boolean;
}) {
  const t = useT(servers);
  const [data, setData] = useState<HostHistoryData>(initial);
  const [loading, setLoading] = useState(false);

  /**
   * Changing window is the **only** request this screen triggers for the history:
   * the 24 h are rendered with the page, on the server side. A `useEffect` fetching
   * the 24 h on mount would have made two round trips for the same data, and shown
   * a gap between the two.
   */
  const select = useCallback(
    async (hours: number) => {
      if (hours === data.hours || loading) return;
      setLoading(true);
      try {
        const response = await fetch(
          `/api/targets/${targetId}/metrics/history?hours=${hours}&buckets=56`,
          { cache: 'no-store' },
        );
        if (response.ok) setData((await response.json()) as HostHistoryData);
      } finally {
        setLoading(false);
      }
    },
    [targetId, data.hours, loading],
  );

  if (data.samples === 0) {
    return (
      <p className="t-cap border-t border-border-subtle px-4 py-3 text-text-3">
        {t('history.empty')}
      </p>
    );
  }

  return (
    <details
      className="group relative border-t border-border-subtle"
      open={defaultOpen}
      aria-busy={loading || undefined}
    >
      <summary className="t-cap flex cursor-pointer list-none items-center gap-1.5 rounded-sm px-4 py-2.5 group-open:pr-28 text-text-3 outline-none hover:text-text-2 focus-visible:shadow-focus [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden
          className="size-3.5 transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none"
        />
        <span className="font-medium text-text-2">{t('history.toggle')}</span>
        <span className="min-w-0 truncate">
          {'· '}
          {t('history.samples', { count: data.samples })}
          {data.reachable === data.samples
            ? ''
            : t('history.unanswered', { count: data.samples - data.reachable })}
        </span>
      </summary>
      <SegmentedControl
        className="absolute top-1.5 right-4"
        label={t('history.window')}
        value={String(data.hours)}
        onChange={(value) => void select(Number(value))}
        options={WINDOWS.map((window) => ({ value: String(window.hours), label: t(window.key) }))}
      />
      <div className="flex flex-col gap-2 px-4 pt-1 pb-3">
        {METRICS.map((metric) => (
          <MetricLine key={metric} metric={metric} data={data} format={format} />
        ))}
      </div>
    </details>
  );
}

const WINDOWS = [
  { hours: 24, key: 'history.window.24h' },
  { hours: 168, key: 'history.window.7d' },
] as const satisfies readonly { hours: number; key: keyof typeof servers.fr }[];
