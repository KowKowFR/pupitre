'use client';

import { useEffect, useState } from 'react';
import {
  SCANNERS,
  SEVERITY_ORDER,
  scannerDescription,
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
import { useLanguage, useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { deployments as messages } from '@/i18n/messages/deployments';
import { cn } from '@/lib/utils';

/**
 * Onglet « Sécurité » d'un déploiement.
 *
 * Aucun scanner n'est nommé en dur : les libellés viennent de `SCANNERS`, la
 * table de données de `@pupitre/core`, et le bouton de téléchargement du SBOM
 * s'affiche sur la foi de `hasSbom`, calculé côté serveur depuis le `kind`.
 *
 * ── Ce qui n'est pas traduit ────────────────────────────────────────────────
 * Le contenu d'un finding — identifiant CVE, paquet, version, intitulé — vient
 * de Trivy ou de Grype, en anglais, et arrive tel quel. La **sévérité** est
 * affichée brute (`CRITICAL`, `HIGH`…) : c'est la valeur d'énumération, celle
 * que porte le filtre de l'URL et celle qu'un script cherche. Les **verdicts**,
 * eux, sont nos mots et se traduisent.
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
  UNKNOWN: 'border-border bg-surface-2 text-text-3',
};

export function SecurityPanel({
  deploymentId,
  refreshKey,
}: {
  deploymentId: string;
  /** Change à chaque transition d'état : recharge sans intervention. */
  refreshKey: string;
}) {
  const t = useT(messages);
  const tc = useT(common);
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
        setError(t('scans.unavailable', { status: response.status }));
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
  }, [deploymentId, refreshKey, t]);

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
        title={t('scans.empty.title')}
        hint={
          config && config.scanners.length === 0
            ? t('scans.empty.noScanner')
            : t('scans.empty.hint')
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
              <CardTitle>
                {t('scans.vulnerabilities', { scanner: SCANNERS[current.scanner].label })}
              </CardTitle>
              <CardDescription>
                {current.kind === 'sbom'
                  ? t('scans.sbom.noVulnerability')
                  : t('scans.findings.summary', {
                      count: total,
                      filter: severity ? ` ${t('scans.findings.filter', { severity })}` : '',
                      image: current.imageRef ?? tc('none'),
                    })}
              </CardDescription>
            </div>
            {current.kind === 'vulnerability' ? (
              <Select
                className="h-8 w-48"
                value={severity}
                onChange={(event) => setSeverity(event.target.value as Severity | '')}
              >
                <option value="">{t('scans.severity.all')}</option>
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
              <p className="text-[0.8125rem] text-text-2">{t('scans.sbom.hint')}</p>
            ) : rows.length === 0 ? (
              <p className="text-[0.8125rem] text-text-2">{t('scans.findings.empty')}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('column.severity')}</TableHead>
                    <TableHead>{t('column.cve')}</TableHead>
                    <TableHead>{t('column.package')}</TableHead>
                    <TableHead>{t('column.version')}</TableHead>
                    <TableHead>{t('column.fix')}</TableHead>
                    <TableHead>{t('column.title')}</TableHead>
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
                        {finding.installedVersion ?? tc('none')}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {finding.fixedVersion ? (
                          <span className="text-ok-text">{finding.fixedVersion}</span>
                        ) : (
                          <span className="text-text-3">{t('findings.noFix')}</span>
                        )}
                      </TableCell>
                      <TableCell className="max-w-md truncate text-xs" title={finding.title ?? ''}>
                        {finding.title ?? tc('none')}
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
  const t = useT(messages);
  const tc = useT(common);
  const language = useLanguage();
  const descriptor = SCANNERS[run.scanner];

  return (
    <Card
      className={cn(
        'cursor-pointer transition-colors duration-100 hover:border-border-strong',
        active && 'border-accent shadow-sm',
        run.verdict === 'fail' && 'border-danger-line',
      )}
      onClick={onSelect}
    >
      <CardHeader className="gap-1.5">
        <CardTitle className="flex items-center gap-2 text-base">
          {descriptor.label}
          <VerdictBadge verdict={run.verdict} status={run.status} />
        </CardTitle>
        <CardDescription className="font-mono text-[0.6875rem] break-all">
          {t('scans.run.meta', {
            image: run.imageRef ?? tc('none'),
            duration: formatMs(run.durationMs, tc('none')),
            failOn: run.failOn,
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {run.error ? (
          <p className="font-mono text-[0.6875rem] break-words text-danger-text">{run.error}</p>
        ) : null}

        {run.kind === 'vulnerability' ? (
          <div className="flex flex-wrap gap-1">
            {SEVERITY_ORDER.map((severity) =>
              run.counts[severity] > 0 ? (
                <SeverityBadge key={severity} severity={severity} count={run.counts[severity]} />
              ) : null,
            )}
            {run.total === 0 && run.status === 'success' ? (
              <span className="text-xs text-ok-text">{t('scans.run.clean')}</span>
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-text-2">{scannerDescription(run.scanner, language)}</p>
        )}

        {run.hasSbom ? (
          <a
            href={`/api/scans/${run.id}/sbom`}
            onClick={(event) => event.stopPropagation()}
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            {t('scans.sbom.download')}
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
  const t = useT(messages);

  if (status === 'failed') {
    return (
      <Badge variant="destructive">{t('verdict.error')}</Badge>
    );
  }
  if (status === 'running') {
    return (
      <Badge variant="default">{t('verdict.running')}</Badge>
    );
  }
  if (verdict === 'fail') {
    return (
      <Badge variant="destructive">{t('verdict.fail')}</Badge>
    );
  }
  if (verdict === 'pass') {
    return (
      <Badge variant="ok">{t('verdict.pass')}</Badge>
    );
  }
  return (
    <Badge variant="warn">{t('verdict.unknown')}</Badge>
  );
}

function formatMs(value: number | null, absent: string): string {
  if (value === null) return absent;
  if (value < 1000) return `${value} ms`;
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} s`;
}
