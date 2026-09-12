'use client';

import { useEffect, useState } from 'react';
import {
  SCANNERS,
  SEVERITY_ORDER,
  type ScanConfig,
  type ScanKind,
  type ScanRunStatus,
  type ScanVerdict,
  type ScannerKey,
  type Severity,
  type SeverityCounts,
} from '@pupitre/core';
import { EmptyState } from '@/components/empty-state';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

/**
 * Onglet « Sécurité » d'un déploiement.
 *
 * Aucun scanner n'est nommé en dur : les libellés viennent de `SCANNERS`, la
 * table de données de `@pupitre/core`, et le bouton de téléchargement du SBOM
 * s'affiche sur la foi de `hasSbom`, calculé côté serveur depuis le `kind`.
 */

type ScanRunView = {
  id: string;
  scanner: ScannerKey;
  kind: ScanKind;
  status: ScanRunStatus;
  verdict: ScanVerdict;
  failOn: string;
  imageRef: string | null;
  error: string | null;
  durationMs: number | null;
  counts: SeverityCounts;
  total: number;
  hasSbom: boolean;
};

type FindingView = {
  id: string;
  cveId: string;
  severity: Severity;
  package: string;
  installedVersion: string | null;
  fixedVersion: string | null;
  title: string | null;
  primaryUrl: string | null;
};

/**
 * Échelle ordinale, pas palette : la teinte descend du rouge au bleu ardoise
 * et perd de la saturation à chaque cran. Les valeurs viennent des jetons —
 * l'échelle tient donc dans les deux thèmes.
 */
const SEVERITY_STYLE: Record<Severity, string> = {
  CRITICAL: 'border-transparent bg-sev-critical text-sev-critical-ink',
  HIGH: 'border-transparent bg-sev-high text-sev-high-ink',
  MEDIUM: 'border-transparent bg-sev-medium text-sev-medium-ink',
  LOW: 'border-transparent bg-sev-low text-sev-low-ink',
  UNKNOWN: 'border-line bg-surface-2 text-ink-faint',
};

export function SecurityPanel({
  deploymentId,
  refreshKey,
}: {
  deploymentId: string;
  /** Change à chaque transition d'état : recharge sans intervention. */
  refreshKey: string;
}) {
  const [runs, setRuns] = useState<ScanRunView[]>([]);
  const [config, setConfig] = useState<ScanConfig | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [findings, setFindings] = useState<FindingView[]>([]);
  const [severity, setSeverity] = useState<Severity | ''>('');
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const response = await fetch(`/api/deployments/${deploymentId}/scans`);
      if (cancelled) return;

      if (!response.ok) {
        setError(`Scans indisponibles (HTTP ${response.status})`);
        setLoading(false);
        return;
      }

      const body = (await response.json()) as { items: ScanRunView[]; config: ScanConfig };
      if (cancelled) return;

      setRuns(body.items);
      setConfig(body.config);
      setError(null);
      setLoading(false);
      setSelected((current) => {
        if (current && body.items.some((run) => run.id === current)) return current;
        // Par défaut, on ouvre l'exécution qui a le plus à dire.
        const withFindings = [...body.items].sort((a, b) => b.total - a.total)[0];
        return withFindings?.id ?? null;
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [deploymentId, refreshKey]);

  useEffect(() => {
    if (!selected) return;

    const params = new URLSearchParams({ pageSize: '200' });
    if (severity) params.set('severity', severity);

    let cancelled = false;
    void (async () => {
      const response = await fetch(`/api/scans/${selected}?${params.toString()}`);
      if (!response.ok || cancelled) return;
      const body = (await response.json()) as {
        findings: { items: FindingView[]; total: number };
      };
      if (cancelled) return;
      setFindings(body.findings.items);
      setTotal(body.findings.total);
    })();

    return () => {
      cancelled = true;
    };
  }, [selected, severity, refreshKey]);

  if (loading && runs.length === 0) {
    return (
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2].map((slot) => (
          <Card key={slot} className="gap-3">
            <CardHeader className="gap-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-48" />
            </CardHeader>
            <CardContent className="flex gap-1.5">
              <Skeleton className="h-5 w-16" />
              <Skeleton className="h-5 w-16" />
              <Skeleton className="h-5 w-12" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (error) return <Alert variant="destructive">{error}</Alert>;

  if (runs.length === 0) {
    return (
      <EmptyState
        title="Aucun scan"
        hint={
          config && config.scanners.length === 0
            ? 'Aucun scanner n’a été sélectionné pour ce déploiement : l’étape a été sautée.'
            : 'Aucun scan enregistré pour ce déploiement.'
        }
      />
    );
  }

  const current = runs.find((run) => run.id === selected) ?? null;
  // La liste appartient à l'exécution sélectionnée : on ne rend rien tant que
  // le rechargement n'a pas répondu pour celle-ci.
  const rows = current ? findings : [];

  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {runs.map((run) => (
          <ScanRunCard
            key={run.id}
            run={run}
            active={run.id === selected}
            onSelect={() => setSelected(run.id)}
          />
        ))}
      </div>

      {current ? (
        <Card>
          <CardHeader className="flex-row items-center justify-between gap-4 space-y-0">
            <div>
              <CardTitle>{SCANNERS[current.scanner].label} — vulnérabilités</CardTitle>
              <CardDescription>
                {current.kind === 'sbom'
                  ? 'Un inventaire de composants n’énonce aucune vulnérabilité.'
                  : `${total} finding(s)${severity ? ` de sévérité ${severity}` : ''} · ${current.imageRef ?? '—'}`}
              </CardDescription>
            </div>
            {current.kind === 'vulnerability' ? (
              <Select
                className="h-8 w-48"
                value={severity}
                onChange={(event) => setSeverity(event.target.value as Severity | '')}
              >
                <option value="">Toutes sévérités</option>
                {SEVERITY_ORDER.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </Select>
            ) : null}
          </CardHeader>
          <CardContent>
            {current.kind === 'sbom' ? (
              <p className="text-[0.8125rem] text-ink-muted">
                Le document est téléchargeable depuis la carte ci-dessus.
              </p>
            ) : rows.length === 0 ? (
              <p className="text-[0.8125rem] text-ink-muted">Aucun finding à afficher.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Sévérité</TableHead>
                    <TableHead>CVE</TableHead>
                    <TableHead>Paquet</TableHead>
                    <TableHead>Version</TableHead>
                    <TableHead>Correctif</TableHead>
                    <TableHead>Intitulé</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((finding) => (
                    <TableRow key={finding.id}>
                      <TableCell>
                        <SeverityBadge severity={finding.severity} />
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {finding.primaryUrl ? (
                          <a
                            href={finding.primaryUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="underline underline-offset-4"
                          >
                            {finding.cveId}
                          </a>
                        ) : (
                          finding.cveId
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{finding.package}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {finding.installedVersion ?? '—'}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {finding.fixedVersion ? (
                          <span className="text-ok">{finding.fixedVersion}</span>
                        ) : (
                          <span className="text-ink-faint">aucun</span>
                        )}
                      </TableCell>
                      <TableCell className="max-w-md truncate text-xs" title={finding.title ?? ''}>
                        {finding.title ?? '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function ScanRunCard({
  run,
  active,
  onSelect,
}: {
  run: ScanRunView;
  active: boolean;
  onSelect: () => void;
}) {
  const descriptor = SCANNERS[run.scanner];

  return (
    <Card
      className={cn(
        'cursor-pointer transition-colors duration-100 hover:border-line-strong',
        active && 'border-signal shadow-raised',
        run.verdict === 'fail' && 'border-danger-edge',
      )}
      onClick={onSelect}
    >
      <CardHeader className="gap-1.5">
        <CardTitle className="flex items-center gap-2 text-base">
          {descriptor.label}
          <VerdictBadge verdict={run.verdict} status={run.status} />
        </CardTitle>
        <CardDescription className="font-mono text-[0.6875rem] break-all">
          {run.imageRef ?? '—'} · {formatMs(run.durationMs)} · seuil {run.failOn}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {run.error ? (
          <p className="font-mono text-[0.6875rem] break-words text-danger">{run.error}</p>
        ) : null}

        {run.kind === 'vulnerability' ? (
          <div className="flex flex-wrap gap-1">
            {SEVERITY_ORDER.map((severity) =>
              run.counts[severity] > 0 ? (
                <SeverityBadge key={severity} severity={severity} count={run.counts[severity]} />
              ) : null,
            )}
            {run.total === 0 && run.status === 'success' ? (
              <span className="text-xs text-ok">aucune vulnérabilité</span>
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-ink-muted">{descriptor.description}</p>
        )}

        {run.hasSbom ? (
          <a
            href={`/api/scans/${run.id}/sbom`}
            onClick={(event) => event.stopPropagation()}
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            Télécharger le SBOM
          </a>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function SeverityBadge({ severity, count }: { severity: Severity; count?: number }) {
  return (
    <Badge className={cn('font-mono', SEVERITY_STYLE[severity])}>
      {severity}
      {count === undefined ? '' : ` ${count}`}
    </Badge>
  );
}

function VerdictBadge({ verdict, status }: { verdict: ScanVerdict; status: ScanRunStatus }) {
  if (status === 'failed') {
    return (
      <Badge variant="destructive">en erreur</Badge>
    );
  }
  if (status === 'running') {
    return (
      <Badge variant="default">en cours</Badge>
    );
  }
  if (verdict === 'fail') {
    return (
      <Badge variant="destructive">bloquant</Badge>
    );
  }
  if (verdict === 'pass') {
    return (
      <Badge variant="ok">conforme</Badge>
    );
  }
  return (
    <Badge variant="warn">indéterminé</Badge>
  );
}

function formatMs(value: number | null): string {
  if (value === null) return '—';
  if (value < 1000) return `${value} ms`;
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} s`;
}
