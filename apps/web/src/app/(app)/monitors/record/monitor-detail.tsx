'use client';

import * as React from 'react';
import Link from 'next/link';
import { Check, Megaphone } from 'lucide-react';
import type { CheckMetrics, MetricDescriptor, Translate } from '@pupitre/core';
import { formatCadence, formatDuration } from '@pupitre/core';
import { Led } from '@/components/instrument';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useLanguage, useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { monitors as messages } from '@/i18n/messages/monitors';
import { servers } from '@/i18n/messages/servers';
import { HealthDot, formatSince } from '@/app/(app)/apps/apps-table';
import { formatDateTimeWith, type FormatSettings } from '@/lib/format';
import { LatencyChart, OutcomeStrip } from '../monitor-charts';
import { IncidentCaptures, type CaptureView } from './incident-captures';

/**
 * A probe's detail: its curve, its incidents timeline, and its measurements
 * table.
 *
 * The table is not an ornament: it is the equivalent of the strip and the curve
 * readable without color. No value of this screen is only reachable on hover.
 *
 * The displayed measurements come from the type's **catalog**, never from a
 * hard-coded list: an HTTP probe shows a code and redirects, a TLS probe days
 * remaining and an issuer, and a type arriving later will show its own without
 * coming back here.
 */

export type CheckRow = {
  id: string;
  checkedAt: string;
  outcome: 'healthy' | 'unhealthy' | 'unreachable';
  latencyMs: number | null;
  detail: string | null;
  metrics: CheckMetrics;
};

export type IncidentRow = {
  id: string;
  startedAt: string;
  resolvedAt: string | null;
  durationSeconds: number | null;
  cause: 'healthy' | 'unhealthy' | 'unreachable' | 'unknown';
  detail: string | null;
  failureCount: number;
  alerted: boolean;
  alertError: string | null;
  resolveAlerted: boolean;
  resolveAlertError: string | null;
};

type Messages = Translate<(typeof messages)['fr']>;

/**
 * A reading's or an incident's instant, in the instance's locale.
 *
 * The components are imposed by the timeline — it fits on one line, a long date
 * would make it overflow. The locale, for its part, comes from `settings.locale`
 * as is: the shortcut of before served `en-GB` to an `en-US` instance. The time
 * zone is not imposed, so as not to move the displayed time in this commit — see
 * `lib/format.ts`.
 */
function formatClock(iso: string, format: FormatSettings): string {
  return formatDateTimeWith(iso, format, {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Formats a measurement according to what the catalog says about it. */
function renderMetric(
  descriptor: MetricDescriptor,
  metrics: CheckMetrics,
  t: Messages,
  format: FormatSettings,
): string | null {
  const value = metrics[descriptor.key];
  if (value === undefined || value === null || value === '') return null;
  switch (descriptor.kind) {
    case 'duration-ms':
      return `${value} ms`;
    case 'days':
      return typeof value === 'number'
        ? t('detail.metric.days', { count: Math.abs(value), value })
        : String(value);
    case 'text':
      // An ISO date reads better in local time.
      if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
        return formatClock(value, format);
      }
      return String(value);
    default:
      return String(value);
  }
}

/** The time alone, for the timeline: the day is already said by the row. */
function shortClock(iso: string, format: FormatSettings): string {
  return formatDateTimeWith(iso, format, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function MonitorDetail({
  monitorId,
  checks,
  incidents,
  captures,
  metrics,
  lastMetrics,
  retentionDays,
  intervalSeconds,
  format,
  announcements = null,
}: {
  monitorId: string;
  checks: CheckRow[];
  incidents: IncidentRow[];
  /** Each incident's captures, indexed by incident. Empty = capture turned off. */
  captures: Record<string, CaptureView[]>;
  metrics: readonly MetricDescriptor[];
  lastMetrics: CheckMetrics;
  retentionDays: number;
  intervalSeconds: number;
  /** The instance's locale and time zone. Through props: this component is rendered
   *  on the server before being rendered in the browser, and both must read the
   *  same value — otherwise hydration diverges. */
  format: FormatSettings;
  /**
   * The announcements published per incident, for whoever can publish them: each
   * incident gains a link to its announcement. `null`: no link.
   */
  announcements?: Record<string, number> | null;
}) {
  const t = useT(messages);
  const tc = useT(common);
  // `formatSince` belongs to the applications screen and speaks its vocabulary:
  // we pass it its `t`, otherwise it falls back on French.
  const tSince = useT(servers);
  const language = useLanguage();
  const points = React.useMemo(
    () =>
      checks.map((check) => ({
        at: check.checkedAt,
        latencyMs: check.latencyMs,
        outcome: check.outcome,
      })),
    [checks],
  );

  const readable = metrics
    .map((descriptor) => ({
      descriptor,
      value: renderMetric(descriptor, lastMetrics, t, format),
    }))
    .filter(
      (entry): entry is { descriptor: MetricDescriptor; value: string } => entry.value !== null,
    );

  return (
    <>
      {readable.length > 0 ? (
        <div
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
          role="group"
          aria-label={t('detail.readout.title')}
        >
          {readable.map(({ descriptor, value }) => (
            <section key={descriptor.key} className="card">
              <div className="card-b flex min-w-0 flex-col gap-1">
                <span className="t-cap text-text-3">{descriptor.label}</span>
                <span
                  className={
                    descriptor.primary
                      ? 't-stat truncate text-[22px] leading-7'
                      : 'mono t-sm break-all text-text'
                  }
                >
                  {value}
                </span>
              </div>
            </section>
          ))}
        </div>
      ) : null}

      <section className="card">
        <div className="card-h">
          <div className="flex min-w-0 flex-col">
            <h2>{t('detail.latency.title')}</h2>
            <span className="sub">
              {t('detail.latency.sub', {
                count: points.length,
                cadence: formatCadence(intervalSeconds, language),
              })}
            </span>
          </div>
        </div>
        <div className="card-b flex flex-col gap-2.5">
          {points.length === 0 ? (
            <p className="t-sm text-text-2">{t('detail.latency.empty')}</p>
          ) : (
            <>
              <LatencyChart points={points} format={format} />
              <OutcomeStrip points={points} format={format} height={14} />
              <span className="t-cap text-text-3">{t('detail.latency.gapNote')}</span>
            </>
          )}
        </div>
      </section>

      <section className="card overflow-hidden">
        <div className="card-h">
          <h2>{t('detail.incidents.title')}</h2>
          <span className="sub">{t('detail.incidents.sub')}</span>
        </div>
        {incidents.length === 0 ? (
          <p className="t-sm px-4 py-3.5 text-text-2">{t('detail.incidents.empty')}</p>
        ) : (
          <ul className="list">
            {incidents.map((incident) => (
              <li key={incident.id} className="flex-col !items-stretch gap-2.5 !py-3.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Led
                    tone={incident.resolvedAt ? 'idle' : 'danger'}
                    pulse={!incident.resolvedAt}
                  />
                  <span className="t-sm font-semibold text-text">
                    {incident.resolvedAt ? t('detail.incident.closed') : t('detail.incident.open')}
                  </span>
                  <span className="mono t-cap text-text-3">
                    {incident.resolvedAt
                      ? `${shortClock(incident.startedAt, format)} → ${shortClock(incident.resolvedAt, format)}`
                      : t('detail.incident.since', {
                          clock: shortClock(incident.startedAt, format),
                        })}
                  </span>
                  <Badge variant={incident.resolvedAt ? 'idle' : 'danger'}>
                    {incident.resolvedAt
                      ? t('detail.incident.outage', {
                          duration: formatDuration(incident.durationSeconds ?? 0, language),
                        })
                      : t('detail.incident.ongoing', {
                          since: formatSince(incident.startedAt, tSince),
                        })}
                  </Badge>
                  <Badge>
                    {t('detail.incident.confirmedAfter', { count: incident.failureCount })}
                  </Badge>
                  {incident.alerted ? (
                    <Badge variant="ok">
                      <Check aria-hidden className="size-3" />
                      {t('detail.incident.alerted')}
                    </Badge>
                  ) : (
                    <Badge variant="outline">{t('detail.incident.notAlerted')}</Badge>
                  )}
                  {incident.resolvedAt ? (
                    incident.resolveAlerted ? (
                      <Badge variant="ok">
                        <Check aria-hidden className="size-3" />
                        {t('detail.incident.resolveAlerted')}
                      </Badge>
                    ) : (
                      <Badge variant="outline">{t('detail.incident.resolveNotAlerted')}</Badge>
                    )
                  ) : null}
                  {announcements ? (
                    <Link
                      href={`/status-pages?announce=incident:${incident.id}`}
                      className="link t-cap ml-auto inline-flex items-center gap-1"
                    >
                      <Megaphone aria-hidden className="size-3.5" />
                      {t('detail.incident.announce', {
                        count: announcements[incident.id] ?? 0,
                      })}
                    </Link>
                  ) : null}
                </div>
                {incident.detail ? (
                  <p className="mono text-[11.5px] break-all text-text-2">{incident.detail}</p>
                ) : null}
                {(incident.alertError ?? incident.resolveAlertError) ? (
                  <Alert variant="warn">
                    {t('detail.incident.webhookFailed', {
                      error: incident.alertError ?? incident.resolveAlertError ?? '',
                    })}
                  </Alert>
                ) : null}
                {/* "Code 503" does not say whether the page was blank, under
                    maintenance or defaced. The image does. */}
                <IncidentCaptures
                  monitorId={monitorId}
                  captures={captures[incident.id] ?? []}
                  format={format}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <Collapsible defaultOpen={false}>
          <div className="card-b">
            <CollapsibleTrigger className="t-sm gap-2">
              <span className="font-semibold text-text">
                {t('detail.checks.count', { count: checks.length })}
              </span>
              <span className="text-text-3">{t('detail.checks.hint')}</span>
            </CollapsibleTrigger>
          </div>
          <CollapsiblePanel className="border-t border-border-subtle">
            <p className="t-cap px-4 pt-3 text-text-3">
              {t('detail.checks.description', { count: retentionDays })}
            </p>
            <Table dense label={t('detail.checks.title')}>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('detail.checks.column.instant')}</TableHead>
                  <TableHead>{t('detail.checks.column.verdict')}</TableHead>
                  <TableHead>{tc('column.duration')}</TableHead>
                  {metrics
                    .filter((descriptor) => descriptor.primary)
                    .map((descriptor) => (
                      <TableHead key={descriptor.key}>{descriptor.label}</TableHead>
                    ))}
                  <TableHead>{tc('column.detail')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {checks
                  .slice()
                  .reverse()
                  .map((check) => (
                    <TableRow key={check.id}>
                      <TableCell className="mono whitespace-nowrap">
                        {formatClock(check.checkedAt, format)}
                      </TableCell>
                      <TableCell>
                        <HealthDot health={check.outcome} label={t(`outcome.${check.outcome}`)} />
                      </TableCell>
                      <TableCell className="mono">
                        {check.latencyMs === null ? tc('none') : `${check.latencyMs} ms`}
                      </TableCell>
                      {metrics
                        .filter((descriptor) => descriptor.primary)
                        .map((descriptor) => (
                          <TableCell key={descriptor.key} className="mono">
                            {renderMetric(descriptor, check.metrics, t, format) ?? tc('none')}
                          </TableCell>
                        ))}
                      <TableCell className="text-text-2">{check.detail ?? tc('none')}</TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </CollapsiblePanel>
        </Collapsible>
      </section>
    </>
  );
}
