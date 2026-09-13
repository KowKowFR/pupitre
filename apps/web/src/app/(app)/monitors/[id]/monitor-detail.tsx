'use client';

import * as React from 'react';
import type { CheckMetrics, MetricDescriptor } from '@pupitre/core';
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
import { HealthDot, formatSince } from '@/app/(app)/apps/apps-table';
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

const OUTCOME_LABEL: Record<string, string> = {
  healthy: 'sain',
  unhealthy: 'répond mal',
  unreachable: 'injoignable',
  unknown: 'inconnu',
};

function formatClock(iso: string): string {
  return new Date(iso).toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Met une mesure en forme selon ce que le catalogue dit d'elle. */
function renderMetric(descriptor: MetricDescriptor, metrics: CheckMetrics): string | null {
  const value = metrics[descriptor.key];
  if (value === undefined || value === null || value === '') return null;
  switch (descriptor.kind) {
    case 'duration-ms':
      return `${value} ms`;
    case 'days':
      return typeof value === 'number'
        ? `${value} jour${Math.abs(value) > 1 ? 's' : ''}`
        : String(value);
    case 'text':
      // Une date ISO se lit mieux à l'heure locale.
      if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) return formatClock(value);
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
}) {
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
    .map((descriptor) => ({ descriptor, value: renderMetric(descriptor, lastMetrics) }))
    .filter((entry): entry is { descriptor: MetricDescriptor; value: string } => entry.value !== null);

  return (
    <div className="flex flex-col gap-5">
      {readable.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Dernier relevé</CardTitle>
            <CardDescription>
              Les mesures que ce type de sonde rapporte. Le taux de disponibilité affiché en tête
              se lit : {uptimeMeans}.
            </CardDescription>
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
          <CardTitle>Latence mesurée</CardTitle>
          <CardDescription>
            Temps jusqu&apos;aux en-têtes de la réponse, pas jusqu&apos;à la fin du
            téléchargement : ce qu&apos;on veut savoir est la réactivité du service, pas le débit
            du lien. Les bandes rouges sont les mesures où rien n&apos;a répondu — le trait est
            coupé plutôt que de raconter une continuité qui n&apos;a pas eu lieu.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {points.length === 0 ? (
            <p className="text-sm text-ink-muted">
              Aucune mesure pour l&apos;instant. La sonde n&apos;a pas encore tourné.
            </p>
          ) : (
            <>
              <LatencyChart points={points} />
              <OutcomeStrip points={points} height={14} />
              <OutcomeLegend />
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Chronologie des incidents</CardTitle>
          <CardDescription>
            Un incident naît à la **transition** — quand le seuil d&apos;échecs consécutifs est
            atteint — et se referme au rétablissement. Un rebond isolé n&apos;en crée aucun. Les
            incidents ne sont jamais purgés, contrairement aux mesures.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {incidents.length === 0 ? (
            <p className="text-sm text-ink-muted">
              Aucun incident. Cette sonde n&apos;est jamais passée en panne confirmée.
            </p>
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
                      label={incident.resolvedAt ? 'incident refermé' : 'incident ouvert'}
                    />
                    <span className="font-mono text-xs text-ink-muted">
                      {formatClock(incident.startedAt)}
                    </span>
                    <Badge variant={incident.resolvedAt ? 'secondary' : 'destructive'}>
                      {incident.resolvedAt
                        ? `${formatDuration(incident.durationSeconds ?? 0)} de panne`
                        : `en cours depuis ${formatSince(incident.startedAt)}`}
                    </Badge>
                    <Badge variant="outline">
                      confirmé après {incident.failureCount} échec
                      {incident.failureCount > 1 ? 's' : ''}
                    </Badge>
                  </div>
                  {incident.detail ? (
                    <p className="font-mono text-[0.6875rem] break-all text-ink-muted">
                      {incident.detail}
                    </p>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    <Badge variant={incident.alerted ? 'ok' : 'secondary'}>
                      {incident.alerted ? 'alerte émise' : 'aucune alerte de panne'}
                    </Badge>
                    {incident.resolvedAt ? (
                      <Badge variant={incident.resolveAlerted ? 'ok' : 'secondary'}>
                        {incident.resolveAlerted
                          ? 'rétablissement annoncé'
                          : 'aucune alerte de rétablissement'}
                      </Badge>
                    ) : null}
                  </div>
                  {incident.alertError ?? incident.resolveAlertError ? (
                    <Alert variant="warn">
                      Webhook non remis : {incident.alertError ?? incident.resolveAlertError}
                    </Alert>
                  ) : null}
                  {/* « Code 503 » ne dit pas si la page était blanche, en
                      maintenance ou défigurée. L'image, si. */}
                  <IncidentCaptures
                    monitorId={monitorId}
                    captures={captures[incident.id] ?? []}
                  />
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Mesures</CardTitle>
          <CardDescription>
            L&apos;équivalent lisible sans couleur de la courbe et de la frise. Conservées{' '}
            {retentionDays} jours.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Collapsible defaultOpen={false}>
            <CollapsibleTrigger className="eyebrow text-ink-muted hover:text-ink">
              {checks.length} mesure{checks.length > 1 ? 's' : ''} — afficher la table
            </CollapsibleTrigger>
            <CollapsiblePanel className="pt-3">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Instant</TableHead>
                      <TableHead>Verdict</TableHead>
                      <TableHead>Durée</TableHead>
                      {metrics
                        .filter((descriptor) => descriptor.primary)
                        .map((descriptor) => (
                          <TableHead key={descriptor.key}>{descriptor.label}</TableHead>
                        ))}
                      <TableHead>Détail</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {checks
                      .slice()
                      .reverse()
                      .map((check) => (
                        <TableRow key={check.id}>
                          <TableCell className="font-mono text-xs whitespace-nowrap">
                            {formatClock(check.checkedAt)}
                          </TableCell>
                          <TableCell>
                            <HealthDot
                              health={check.outcome}
                              label={OUTCOME_LABEL[check.outcome] ?? check.outcome}
                            />
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {check.latencyMs === null ? '—' : `${check.latencyMs} ms`}
                          </TableCell>
                          {metrics
                            .filter((descriptor) => descriptor.primary)
                            .map((descriptor) => (
                              <TableCell key={descriptor.key} className="font-mono text-xs">
                                {renderMetric(descriptor, check.metrics) ?? '—'}
                              </TableCell>
                            ))}
                          <TableCell className="text-xs text-ink-muted">
                            {check.detail ?? '—'}
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
