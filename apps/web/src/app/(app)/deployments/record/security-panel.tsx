'use client';

import { useEffect, useState } from 'react';
import {
  SCANNERS,
  SEVERITY_ORDER,
  VULNERABILITY_ACCEPTANCE_DURATIONS,
  VULNERABILITY_ACCEPTANCE_REASON_MIN,
  scannerDescription,
  type ScanConfig,
  type ScanKind,
  type ScanRunStatus,
  type ScanVerdict,
  type ScannerKey,
  type Severity,
  type SeverityCounts,
} from '@pupitre/core';
import { Download, ShieldCheck, ShieldOff, Undo2 } from 'lucide-react';
import { EmptyState } from '@/components/empty-state';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Textarea } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented';
import { Select } from '@/components/ui/select';
import { IconButton } from '@/components/ui/tooltip';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useLanguage, useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { deployments as messages } from '@/i18n/messages/deployments';
import { vulnerabilities } from '@/i18n/messages/vulnerabilities';
import { toast } from '@/lib/toast';
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
  onlyFixable: boolean;
  imageRef: string | null;
  error: string | null;
  durationMs: number | null;
  counts: SeverityCounts;
  total: number;
  fixable: number;
  accepted: number;
  hasSbom: boolean;
};

type FindingsView = 'all' | 'fixable' | 'unfixable' | 'accepted';
const FINDINGS_VIEWS: readonly FindingsView[] = ['all', 'fixable', 'unfixable', 'accepted'];

type AcceptanceView = {
  id: string;
  package: string | null;
  reason: string;
  expiresAt: string | null;
  authorName: string | null;
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
  /** L'acceptation qui la couvre aujourd'hui, pour l'application. */
  acceptance: AcceptanceView | null;
};

/**
 * Échelle ordinale, pas palette : la teinte descend du rouge au bleu ardoise
 * et perd de la saturation à chaque cran. Les valeurs viennent des jetons —
 * l'échelle tient donc dans les deux thèmes.
 */
const SEVERITY_CLASS: Record<Severity, string> = {
  CRITICAL: 'sev-c',
  HIGH: 'sev-h',
  MEDIUM: 'sev-m',
  LOW: 'sev-l',
  UNKNOWN: 'sev-u',
};

/** Les sévérités affichées sur une carte, même à zéro : l'absence se lit aussi. */
const CARD_SEVERITIES: readonly Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

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
  const [view, setView] = useState<FindingsView>('all');
  const [total, setTotal] = useState(0);
  const [context, setContext] = useState<{
    applicationId: string;
    applicationSlug: string;
    canAccept: boolean;
  } | null>(null);
  const [accepting, setAccepting] = useState<FindingView | null>(null);
  // Une acceptation posée ou retirée relit la liste et les comptes.
  const [version, setVersion] = useState(0);
  const tv = useT(vulnerabilities);
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
  }, [deploymentId, refreshKey, t, version]);

  useEffect(() => {
    if (!selected) return;

    const params = new URLSearchParams({ pageSize: '200', view });
    if (severity) params.set('severity', severity);

    let cancelled = false;
    void (async () => {
      const response = await fetch(`/api/scans/${selected}?${params.toString()}`);
      if (!response.ok || cancelled) return;
      const body = (await response.json()) as {
        applicationId: string;
        applicationSlug: string;
        canAccept: boolean;
        findings: { items: FindingView[]; total: number };
      };
      if (cancelled) return;
      setFindings(body.findings.items);
      setTotal(body.findings.total);
      setContext({
        applicationId: body.applicationId,
        applicationSlug: body.applicationSlug,
        canAccept: body.canAccept,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [selected, severity, view, refreshKey, version]);

  async function revoke(finding: FindingView) {
    if (!context || !finding.acceptance) return;
    const response = await fetch(
      `/api/applications/${context.applicationId}/vulnerability-acceptances/${finding.acceptance.id}`,
      { method: 'DELETE' },
    );
    if (!response.ok) {
      toast({ title: tc('http.failure', { status: response.status }), tone: 'danger' });
      return;
    }
    toast({ title: tv('toast.acceptanceRemoved', { cve: finding.cveId }), tone: 'ok' });
    setVersion((value) => value + 1);
  }

  if (loading && runs.length === 0) {
    return (
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3" aria-busy>
        {[0, 1, 2].map((slot) => (
          <section key={slot} className="card">
            <div className="card-h">
              <Skeleton className="sk-t w-20" />
              <Skeleton className="ml-auto h-5 w-20" />
            </div>
            <div className="card-b flex flex-col gap-2.5">
              <Skeleton className="sk-t w-56" />
              <div className="flex gap-1.5">
                <Skeleton className="h-5 w-16" />
                <Skeleton className="h-5 w-14" />
                <Skeleton className="h-5 w-16" />
                <Skeleton className="h-5 w-12" />
              </div>
            </div>
          </section>
        ))}
      </div>
    );
  }

  if (error) return <Alert variant="destructive">{error}</Alert>;

  if (runs.length === 0) {
    return (
      <EmptyState
        icon={ShieldCheck}
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
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
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
        <section className="card overflow-hidden">
          <div className="card-h flex-wrap">
            <h2>{t('scans.vulnerabilities', { scanner: SCANNERS[current.scanner].label })}</h2>
            <span className="sub min-w-0 truncate">
              {current.kind === 'sbom'
                ? t('scans.sbom.noVulnerability')
                : t('scans.findings.summary', {
                    count: total,
                    filter: severity ? ` ${t('scans.findings.filter', { severity })}` : '',
                    image: current.imageRef ?? tc('none'),
                  })}
            </span>
            {current.kind === 'vulnerability' ? (
              <SegmentedControl
                className="ml-auto"
                value={view}
                onChange={setView}
                label={tv('view.label')}
                options={FINDINGS_VIEWS.map((option) => ({
                  value: option,
                  label: tv(`view.${option}`),
                }))}
              />
            ) : null}
            {current.kind === 'vulnerability' ? (
              <Select
                className="input-sm w-48"
                aria-label={t('column.severity')}
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
          </div>
          {current.kind === 'sbom' ? (
            <p className="t-sm px-4 py-3 text-text-2">{t('scans.sbom.hint')}</p>
          ) : rows.length === 0 ? (
            <p className="t-sm px-4 py-3 text-text-2">{t('scans.findings.empty')}</p>
          ) : (
            <Table
              dense
              label={t('scans.vulnerabilities', { scanner: SCANNERS[current.scanner].label })}
            >
              <TableHeader>
                <TableRow>
                  <TableHead>{t('column.severity')}</TableHead>
                  <TableHead>{t('column.cve')}</TableHead>
                  <TableHead>{t('column.package')}</TableHead>
                  <TableHead>{t('column.version')}</TableHead>
                  <TableHead>{t('column.fix')}</TableHead>
                  <TableHead>{t('column.title')}</TableHead>
                  {context?.canAccept || rows.some((row) => row.acceptance) ? <TableHead /> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((finding) => (
                  <TableRow key={finding.id}>
                    <TableCell>
                      <SeverityBadge severity={finding.severity} />
                    </TableCell>
                    <TableCell className="mono whitespace-nowrap">
                      {finding.primaryUrl ? (
                        <a
                          href={finding.primaryUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="link"
                        >
                          {finding.cveId}
                        </a>
                      ) : (
                        finding.cveId
                      )}
                    </TableCell>
                    <TableCell className="mono">{finding.package}</TableCell>
                    <TableCell className="mono whitespace-nowrap">
                      {finding.installedVersion ?? tc('none')}
                    </TableCell>
                    <TableCell className="mono whitespace-nowrap">
                      {finding.fixedVersion ?? (
                        <span className="font-sans text-text-3">{t('findings.noFix')}</span>
                      )}
                    </TableCell>
                    <TableCell className="max-w-md truncate" title={finding.title ?? ''}>
                      {finding.title ?? tc('none')}
                    </TableCell>
                    {context?.canAccept || rows.some((row) => row.acceptance) ? (
                      <TableCell className="whitespace-nowrap text-right">
                        {finding.acceptance ? (
                          <span className="inline-flex items-center gap-1.5">
                            <Badge
                              variant="ok"
                              title={tv('accepted.title', {
                                by: finding.acceptance.authorName ?? '',
                                reason: finding.acceptance.reason,
                              })}
                            >
                              {tv('accepted.badge')}
                            </Badge>
                            {context?.canAccept ? (
                              <IconButton
                                label={tv('accepted.revoke')}
                                onClick={() => void revoke(finding)}
                              >
                                <Undo2 aria-hidden />
                              </IconButton>
                            ) : null}
                          </span>
                        ) : context?.canAccept ? (
                          <IconButton
                            label={tv('accept.title', { cve: finding.cveId })}
                            onClick={() => setAccepting(finding)}
                          >
                            <ShieldOff aria-hidden />
                          </IconButton>
                        ) : null}
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>
      ) : null}

      {accepting && context ? (
        <AcceptDialog
          finding={accepting}
          applicationId={context.applicationId}
          applicationSlug={context.applicationSlug}
          onClose={() => setAccepting(null)}
          onAccepted={() => {
            setAccepting(null);
            setVersion((value) => value + 1);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Accepter une faille pour l'application : un motif, une portée (ce paquet,
 * ou la CVE partout), une échéance. Elle restera listée, mais ne bloquera plus.
 */
function AcceptDialog({
  finding,
  applicationId,
  applicationSlug,
  onClose,
  onAccepted,
}: {
  finding: FindingView;
  applicationId: string;
  applicationSlug: string;
  onClose: () => void;
  onAccepted: () => void;
}) {
  const tv = useT(vulnerabilities);
  const tc = useT(common);
  const [scope, setScope] = useState<'package' | 'any'>('package');
  const [days, setDays] = useState<string>('90');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    setPending(true);
    setError(null);
    const response = await fetch(`/api/applications/${applicationId}/vulnerability-acceptances`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cveId: finding.cveId,
        package: scope === 'package' ? finding.package : null,
        reason,
        expiresInDays: days === 'never' ? null : Number(days),
      }),
    });
    setPending(false);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
      setError(body.error?.message ?? tc('http.failure', { status: response.status }));
      return;
    }
    toast({
      title: tv('toast.accepted', { cve: finding.cveId, app: applicationSlug }),
      tone: 'ok',
    });
    onAccepted();
  }

  return (
    <Dialog open onOpenChange={(open) => (open || pending ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader icon={<ShieldOff />} tone="warn">
          <DialogTitle>{tv('accept.title', { cve: finding.cveId })}</DialogTitle>
          <DialogDescription>{tv('accept.body', { app: applicationSlug })}</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <Field label={tv('accept.scope')}>
            <SegmentedControl
              value={scope}
              onChange={setScope}
              label={tv('accept.scope')}
              options={[
                {
                  value: 'package',
                  label: tv('accept.scope.package', { package: finding.package }),
                },
                { value: 'any', label: tv('accept.scope.any') },
              ]}
            />
          </Field>
          <Field label={tv('accept.reason')} help={tv('accept.reason.help')}>
            <Textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
              maxLength={500}
              placeholder={tv('accept.reason.placeholder')}
            />
          </Field>
          <Field label={tv('accept.expires')}>
            <SegmentedControl
              value={days}
              onChange={setDays}
              label={tv('accept.expires')}
              options={VULNERABILITY_ACCEPTANCE_DURATIONS.map((value) =>
                value === null
                  ? { value: 'never', label: tv('accept.expires.never') }
                  : { value: String(value), label: tv('accept.expires.days', { count: value }) },
              )}
            />
          </Field>
          {error ? <Alert variant="destructive">{error}</Alert> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            {tv('accept.cancel')}
          </Button>
          <Button
            loading={pending}
            disabled={reason.trim().length < VULNERABILITY_ACCEPTANCE_REASON_MIN}
            onClick={accept}
          >
            {tv('accept.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  const tv = useT(vulnerabilities);
  const language = useLanguage();
  const descriptor = SCANNERS[run.scanner];

  return (
    // La carte entière choisit l'exécution dont la liste s'affiche dessous : un
    // vrai bouton, pour le clavier. Le lien de téléchargement vit à côté.
    <section className={cn('card flex flex-col', active && 'border-accent shadow-focus')}>
      <button
        type="button"
        aria-pressed={active}
        onClick={onSelect}
        className="card-h w-full rounded-t-[inherit] text-left outline-none focus-visible:shadow-focus"
      >
        <h3 className="text-[14px] font-semibold">{descriptor.label}</h3>
        <span className="ml-auto">
          <VerdictBadge verdict={run.verdict} status={run.status} />
        </span>
      </button>
      <div className="card-b flex flex-1 flex-col gap-2.5">
        <span className="mono text-[11.5px] break-all text-text-3">
          {t('scans.run.meta', {
            image: run.imageRef ?? tc('none'),
            duration: formatMs(run.durationMs, tc('none')),
            failOn: run.failOn,
          })}
        </span>

        {run.error ? (
          <p className="mono text-[11.5px] break-words text-danger-text">{run.error}</p>
        ) : null}

        {run.kind === 'vulnerability' ? (
          <div className="flex flex-wrap gap-1.5">
            {CARD_SEVERITIES.map((severity) =>
              run.counts[severity] > 0 ? (
                <SeverityBadge key={severity} severity={severity} count={run.counts[severity]} />
              ) : (
                <Badge key={severity} variant="outline" className="mono">
                  {severity} 0
                </Badge>
              ),
            )}
            {run.counts.UNKNOWN > 0 ? (
              <SeverityBadge severity="UNKNOWN" count={run.counts.UNKNOWN} />
            ) : null}
          </div>
        ) : null}

        {run.kind === 'vulnerability' && run.total > 0 ? (
          <p className="t-cap text-text-2">
            {tv('run.fixable', { count: run.fixable })}
            {run.accepted > 0 ? ` · ${tv('run.accepted', { count: run.accepted })}` : ''}
            {run.onlyFixable ? ` · ${tv('run.onlyFixable')}` : ''}
          </p>
        ) : null}

        {run.kind === 'vulnerability' ? null : (
          <p className="t-cap text-text-3">{scannerDescription(run.scanner, language)}</p>
        )}

        {run.hasSbom ? (
          <Button asChild size="sm" variant="secondary" className="self-start">
            <a href={`/api/scans/${run.id}/sbom`}>
              <Download aria-hidden />
              {t('scans.sbom.download')}
            </a>
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function SeverityBadge({ severity, count }: { severity: Severity; count?: number }) {
  return (
    <span className={cn('sev', SEVERITY_CLASS[severity])}>
      {severity}
      {count === undefined ? '' : ` ${count}`}
    </span>
  );
}

function VerdictBadge({ verdict, status }: { verdict: ScanVerdict; status: ScanRunStatus }) {
  const t = useT(messages);

  if (status === 'failed') {
    return (
      <Badge variant="danger" dot>
        {t('verdict.error')}
      </Badge>
    );
  }
  if (status === 'running') {
    return (
      <Badge variant="accent" dot>
        {t('verdict.running')}
      </Badge>
    );
  }
  if (verdict === 'fail') {
    return (
      <Badge variant="danger" dot>
        {t('verdict.fail')}
      </Badge>
    );
  }
  if (verdict === 'pass') {
    return (
      <Badge variant="ok" dot>
        {t('verdict.pass')}
      </Badge>
    );
  }
  return (
    <Badge variant="warn" dot>
      {t('verdict.unknown')}
    </Badge>
  );
}

function formatMs(value: number | null, absent: string): string {
  if (value === null) return absent;
  if (value < 1000) return `${value} ms`;
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} s`;
}
