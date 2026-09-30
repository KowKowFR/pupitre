'use client';

import * as React from 'react';
import { Check } from 'lucide-react';
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
 * Détail d'une sonde : sa courbe, sa chronologie d'incidents, et la table de
 * ses mesures.
 *
 * La table n'est pas un ornement : c'est l'équivalent lisible sans couleur de la
 * frise et de la courbe. Aucune valeur de cet écran n'est accessible seulement
 * au survol.
 *
 * Les mesures affichées viennent du **catalogue** du type, jamais d'une liste
 * écrite en dur : une sonde HTTP montre un code et des redirections, une sonde
 * TLS des jours restants et un émetteur, et un type qui arrivera plus tard
 * montrera les siennes sans qu'on repasse ici.
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
 * L'instant d'un relevé ou d'un incident, dans la locale de l'instance.
 *
 * Les composantes sont imposées par la chronologie — elle tient sur une ligne,
 * une date longue la ferait déborder. La locale, elle, vient de
 * `settings.locale` telle quelle : le raccourci d'avant servait `en-GB` à une
 * instance `en-US`. Le fuseau n'est pas imposé, pour ne pas déplacer l'heure
 * affichée dans ce commit — voir `lib/format.ts`.
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

/** Met une mesure en forme selon ce que le catalogue dit d'elle. */
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
      // Une date ISO se lit mieux à l'heure locale.
      if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
        return formatClock(value, format);
      }
      return String(value);
    default:
      return String(value);
  }
}

/** L'heure seule, pour la chronologie : le jour est déjà dit par la ligne. */
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
}: {
  monitorId: string;
  checks: CheckRow[];
  incidents: IncidentRow[];
  /** Les captures de chaque incident, indexées par incident. Vide = capture éteinte. */
  captures: Record<string, CaptureView[]>;
  metrics: readonly MetricDescriptor[];
  lastMetrics: CheckMetrics;
  retentionDays: number;
  intervalSeconds: number;
  /** Locale et fuseau de l'instance. Par props : ce composant est rendu sur le
   *  serveur avant de l'être dans le navigateur, et les deux doivent lire la
   *  même valeur — sinon l'hydratation diverge. */
  format: FormatSettings;
}) {
  const t = useT(messages);
  const tc = useT(common);
  // `formatSince` appartient à l'écran des applications et parle son
  // vocabulaire : on lui passe son `t`, sinon il retombe sur le français.
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
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
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
                {/* « Code 503 » ne dit pas si la page était blanche, en
                    maintenance ou défigurée. L'image, si. */}
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
