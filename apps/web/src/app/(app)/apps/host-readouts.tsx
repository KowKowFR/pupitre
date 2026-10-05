'use client';

import type { ReactNode } from 'react';
import type { HostMetrics, Translate } from '@pupitre/core';
import { Led, Readout, ReadoutBar, type Tone } from '@/components/instrument';
import { Alert } from '@/components/ui/alert';
import { useT } from '@/i18n/client';
import { servers } from '@/i18n/messages/servers';
import { withSlot } from '@/lib/rich';
import {
  toneFor,
  trendText,
  type HistoryMetric,
  type MetricSummaryView,
  type ThresholdView,
} from './host-history';
import type { MetricsEntry } from './use-host-metrics';

/**
 * A server's metrics, readable at a glance.
 *
 * Three principles:
 *
 * 1. **Nothing in raw bytes alone.** "3.2 GiB free" says nothing without the
 *    total; a load of 4 says nothing without the number of cores. Each reading is
 *    therefore rendered as a proportion — a percentage — and the absolute figure
 *    comes underneath, for whoever wants the detail.
 * 2. **Unknown is not zero.** A missing metric shows "unknown". A zero would
 *    suggest an empty disk or an idle machine, which is exactly the opposite of a
 *    piece of information.
 * 3. **The state reads from the shape.** A cell's indicator carries its tone
 *    through its halo, and the trend is written out in full: the reading survives
 *    color blindness and a grayscale screenshot.
 */

type T = Translate<typeof servers.fr>;

/**
 * KiB → GiB. Two divisions by 1024, so indeed **gibibytes**: English says `GiB`,
 * not `GB`. A unit that lies about its base makes one doubt the figure.
 */
function gib(kb: number): string {
  return (kb / 1024 / 1024).toFixed(kb / 1024 / 1024 < 10 ? 1 : 0);
}

function formatUptime(seconds: number | null, t: T): string {
  if (seconds === null) return t('unknown');
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return t('uptime.days', { days, hours });
  if (hours > 0) return t('uptime.hours', { hours, minutes });
  return t('uptime.minutes', { minutes });
}

/**
 * The display's **default** thresholds, when none has been resolved yet for the
 * machine — the very first rendering of a target never read. The real values
 * come from the database; these are the same, hard-coded, so that the screen does
 * not change color between two loads.
 */
const FALLBACK_THRESHOLDS: Record<HistoryMetric, ThresholdView> = {
  disk: { limitPercent: 85, enabled: true, origin: 'default' },
  memory: { limitPercent: 90, enabled: true, origin: 'default' },
  load: { limitPercent: 100, enabled: true, origin: 'default' },
};

/** The band, on the card's recessed background, right under its header. */
function Band({ children }: { children: ReactNode }) {
  return <div className="bg-bg-subtle">{children}</div>;
}

/** A missing value: written, in gray — never a zero. */
function Unknown({ t }: { t: T }) {
  return <span className="text-text-3">{t('unknown')}</span>;
}

/** The four cells during the reading: the exact silhouette of what is coming. */
function Pending({ t }: { t: T }) {
  const labels = [t('metric.load'), t('metric.memory'), t('metric.disk'), t('metric.uptime')];
  return (
    <>
      <span role="status" className="sr-only">
        {t('readout.pending')}
      </span>
      <ReadoutBar bare compact>
        {labels.map((label) => (
          <Readout
            key={label}
            label={label}
            tone="accent"
            pulse
            value={<span aria-hidden className="sk inline-block h-[22px] w-14 align-middle" />}
            hint={<span aria-hidden className="sk sk-t inline-block w-28" />}
          />
        ))}
      </ReadoutBar>
    </>
  );
}

export function HostReadouts({
  entry,
  enabled,
  thresholds = FALLBACK_THRESHOLDS,
  summary,
}: {
  entry: MetricsEntry | undefined;
  enabled: boolean;
  /**
   * **This** machine's thresholds. They decide the red, and they are exactly those
   * that decide the alert: a single reference value for the color and for the
   * log, instead of two that could diverge.
   */
  thresholds?: Record<HistoryMetric, ThresholdView>;
  /** The history window, where the trend shown to the right of each cell comes from. */
  summary?: Record<HistoryMetric, MetricSummaryView>;
}) {
  const t = useT(servers);

  if (!enabled) {
    return (
      <Band>
        <p className="t-sm flex items-center gap-2 px-4 py-3 text-text-2">
          <Led tone="idle" />
          <span className="min-w-0">{t('readout.restricted')}</span>
        </p>
      </Band>
    );
  }

  if (entry === undefined || entry.state === 'loading') {
    return (
      <Band>
        <Pending t={t} />
      </Band>
    );
  }

  if (entry.state === 'error') {
    return (
      <Band>
        <div className="px-4 py-3">
          <Alert variant="destructive">{t('readout.failed', { message: entry.message })}</Alert>
        </div>
      </Band>
    );
  }

  const metrics: HostMetrics = entry.metrics;

  if (!metrics.reachable) {
    return (
      <Band>
        <div className="px-4 py-3">
          <Alert variant="destructive">
            {withSlot(
              (reason) => t('readout.unreachable', { reason }),
              <span className="mono">{metrics.error ?? t('readout.unreachable.reason')}</span>,
            )}
          </Alert>
        </div>
      </Band>
    );
  }

  const { load, memory, disk } = metrics;
  const trend = (metric: HistoryMetric) =>
    summary ? trendText(summary[metric].trend, t) : undefined;
  const tone = (metric: HistoryMetric, value: number | null): Tone =>
    toneFor(value, thresholds[metric].limitPercent, thresholds[metric].enabled);

  // The load only makes sense relative to the cores: without `nproc`, we show the
  // raw number and say frankly that we cannot divide.
  const perCore = load?.perCore === null || load?.perCore === undefined ? null : load.perCore * 100;

  return (
    <Band>
      <ReadoutBar bare compact>
        <Readout
          label={t('metric.load')}
          tone={tone('load', perCore)}
          aside={trend('load')}
          value={
            load === null ? (
              <Unknown t={t} />
            ) : perCore === null ? (
              load.one.toFixed(2)
            ) : (
              Math.round(perCore)
            )
          }
          unit={perCore === null ? undefined : '%'}
          hint={
            load === null
              ? t('load.noSource')
              : load.cores === null
                ? t('load.noCores', {
                    five: load.five.toFixed(2),
                    fifteen: load.fifteen.toFixed(2),
                  })
                : t('load.perCore', { percent: Math.round(perCore ?? 0), count: load.cores })
          }
        />

        <Readout
          label={t('metric.memory')}
          tone={tone('memory', memory?.usedPercent ?? null)}
          aside={trend('memory')}
          value={memory === null ? <Unknown t={t} /> : Math.round(memory.usedPercent)}
          unit={memory === null ? undefined : '%'}
          hint={
            memory === null
              ? t('memory.noSource')
              : t('memory.used', { used: gib(memory.usedKb), total: gib(memory.totalKb) })
          }
        />

        <Readout
          label={t('metric.disk')}
          tone={tone('disk', disk?.usePercent ?? null)}
          aside={trend('disk')}
          value={disk === null ? <Unknown t={t} /> : disk.usePercent}
          unit={disk === null ? undefined : '%'}
          hint={
            disk === null
              ? t('disk.noSource')
              : t('disk.free', { free: gib(disk.availableKb), path: disk.path })
          }
        />

        <Readout
          label={t('metric.uptime')}
          tone={metrics.uptimeSeconds === null ? 'idle' : 'ok'}
          value={
            metrics.uptimeSeconds === null ? (
              <Unknown t={t} />
            ) : (
              formatUptime(metrics.uptimeSeconds, t)
            )
          }
          hint={metrics.os.prettyName ?? metrics.os.kernel ?? t('os.unknown')}
        />
      </ReadoutBar>
    </Band>
  );
}
