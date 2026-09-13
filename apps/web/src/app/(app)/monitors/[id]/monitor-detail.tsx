'use client';

import * as React from 'react';
import type { CheckMetrics, MetricDescriptor, Translate } from '@pupitre/core';
import { formatDuration } from '@pupitre/core';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { LatencyChart, OutcomeLegend, OutcomeStrip } from '../monitor-charts';
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

export function MonitorDetail({
  monitorId,
  checks,
  incidents,
  captures,
  metrics,
  lastMetrics,
  retentionDays,
  uptimeMeans,
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
  uptimeMeans: string;
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
    .filter((entry): entry is { descriptor: MetricDescriptor; value: string } => entry.value !== null);

  return (
    <div className="flex flex-col gap-5">
      {readable.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('detail.readout.title')}</CardTitle>
            <CardDescription>{t('detail.readout.description', { uptimeMeans })}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {readable.map(({ descriptor, value }) => (
              <div key={descriptor.key} className="space-y-0.5">
                <div className="eyebrow text-ink-faint">{descriptor.label}</div>
                <div
                  className={
                    descriptor.primary
                      ? 'font-mono text-sm text-ink'
                      : 'font-mono text-xs break-all text-ink-muted'
                  }
                >
                  {value}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t('detail.latency.title')}</CardTitle>
          <CardDescription>{t('detail.latency.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {points.length === 0 ? (
            <p className="text-sm text-ink-muted">{t('detail.latency.empty')}</p>
          ) : (
            <>
              <LatencyChart points={points} format={format} />
              <OutcomeStrip points={points} format={format} height={14} />
              <OutcomeLegend />
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('detail.incidents.title')}</CardTitle>
          <CardDescription>
            {t('detail.incidents.description.a')}
            <strong>{t('detail.incidents.description.transition')}</strong>
            {t('detail.incidents.description.b')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {incidents.length === 0 ? (
            <p className="text-sm text-ink-muted">{t('detail.incidents.empty')}</p>
          ) : (
            <ol className="space-y-3">
              {incidents.map((incident) => (
                <li
                  key={incident.id}
                  className="flex flex-col gap-1 border-l-2 pl-3"
                  style={{
                    borderColor: incident.resolvedAt ? 'var(--line-strong)' : 'var(--danger)',
                  }}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <HealthDot
                      health={incident.resolvedAt ? 'healthy' : incident.cause}
                      label={
                        incident.resolvedAt
                          ? t('detail.incident.closed')
                          : t('detail.incident.open')
                      }
                    />
                    <span className="font-mono text-xs text-ink-muted">
                      {formatClock(incident.startedAt, format)}
                    </span>
                    <Badge variant={incident.resolvedAt ? 'secondary' : 'destructive'}>
                      {incident.resolvedAt
                        ? t('detail.incident.outage', {
                            duration: formatDuration(incident.durationSeconds ?? 0, language),
                          })
                        : t('detail.incident.ongoing', {
                            since: formatSince(incident.startedAt, tSince),
                          })}
                    </Badge>
                    <Badge variant="outline">
                      {t('detail.incident.confirmedAfter', { count: incident.failureCount })}
                    </Badge>
                  </div>
                  {incident.detail ? (
                    <p className="font-mono text-[0.6875rem] break-all text-ink-muted">
                      {incident.detail}
                    </p>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    <Badge variant={incident.alerted ? 'ok' : 'secondary'}>
                      {incident.alerted
                        ? t('detail.incident.alerted')
                        : t('detail.incident.notAlerted')}
                    </Badge>
                    {incident.resolvedAt ? (
                      <Badge variant={incident.resolveAlerted ? 'ok' : 'secondary'}>
                        {incident.resolveAlerted
                          ? t('detail.incident.resolveAlerted')
                          : t('detail.incident.resolveNotAlerted')}
                      </Badge>
                    ) : null}
                  </div>
                  {incident.alertError ?? incident.resolveAlertError ? (
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
            </ol>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('detail.checks.title')}</CardTitle>
          <CardDescription>
            {t('detail.checks.description', { count: retentionDays })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Collapsible defaultOpen={false}>
            <CollapsibleTrigger className="eyebrow text-ink-muted hover:text-ink">
              {t('detail.checks.toggle', { count: checks.length })}
            </CollapsibleTrigger>
            <CollapsiblePanel className="pt-3">
              <div className="overflow-x-auto">
                <Table>
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
                          <TableCell className="font-mono text-xs whitespace-nowrap">
                            {formatClock(check.checkedAt, format)}
                          </TableCell>
                          <TableCell>
                            <HealthDot
                              health={check.outcome}
                              label={t(`outcome.${check.outcome}`)}
                            />
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {check.latencyMs === null ? tc('none') : `${check.latencyMs} ms`}
                          </TableCell>
                          {metrics
                            .filter((descriptor) => descriptor.primary)
                            .map((descriptor) => (
                              <TableCell key={descriptor.key} className="font-mono text-xs">
                                {renderMetric(descriptor, check.metrics, t, format) ??
                                  tc('none')}
                              </TableCell>
                            ))}
                          <TableCell className="text-xs text-ink-muted">
                            {check.detail ?? tc('none')}
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </div>
            </CollapsiblePanel>
          </Collapsible>
        </CardContent>
      </Card>
    </div>
  );
}
