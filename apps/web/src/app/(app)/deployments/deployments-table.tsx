'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Search, Trash2 } from 'lucide-react';
import {
  SEVERITY_ORDER,
  type DeploymentStatus,
  type ScanVerdict,
  type ScannerKey,
  type SeverityCounts,
  type Translate,
} from '@pupitre/core';
import { Alert } from '@/components/ui/alert';
import { Badge, CodeBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useDrawerSelection } from '@/components/ui/drawer';
import { FilterChipLink } from '@/components/ui/filter-chip';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tooltip } from '@/components/ui/tooltip';
import { useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { deployments as messages } from '@/i18n/messages/deployments';
import type { CommitSource } from '@/lib/commit';
import type { FormatSettings } from '@/lib/format';
import { toast } from '@/lib/toast';
import { filterParams, type StatusFilter } from './filters';
import { RunDrawer } from './run-drawer';
import { DeploymentStatusBadge, formatDate, formatDuration } from './status-badge';

export type DeploymentRow = {
  id: string;
  /** Numéro de run, global à l'instance. */
  number: number;
  status: DeploymentStatus;
  runtime: 'docker' | 'k3s';
  version: number;
  url: string | null;
  applicationSlug: string;
  targetName: string;
  triggeredByEmail: string | null;
  /** Le commit déployé, quand le run vient d'un dépôt lié. */
  source: CommitSource | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  /**
   * Ce run est la version en service sur sa cible — ou il tourne encore.
   * Dans les deux cas il ne se purge pas : c'est le serveur qui tranche, la
   * case désactivée ne fait qu'éviter d'annoncer un geste qui sera refusé.
   */
  purgeBlocked: boolean;
  /** Résumé des scans : quels outils ont tourné et avec quel verdict. */
  scan: {
    scanners: ScannerKey[];
    verdict: ScanVerdict | null;
    counts: SeverityCounts;
  } | null;
};

type PurgeRefusal = {
  id: string;
  number: number;
  status: DeploymentStatus;
  version: number;
  applicationSlug: string;
  targetName: string;
  reason: 'live' | 'in_progress';
  message: string;
};

type PurgeReport = {
  matched: number;
  purgedCount: number;
  purgedByStatus: Record<string, number>;
  refused: PurgeRefusal[];
  refusedCount: number;
  releasedPorts: Array<{ targetId: string; targetName: string; port: number }>;
  rollbackTargetsLost: number;
  truncated: boolean;
  limit: number;
};

type ApiError = { error?: { message?: string } };

const FILTERS: ReadonlyArray<{ value: StatusFilter; key: keyof typeof messages.fr }> = [
  { value: null, key: 'filter.all' },
  { value: 'running', key: 'filter.running' },
  { value: 'failed', key: 'filter.failed' },
  { value: 'rolled_back', key: 'filter.rolledBack' },
  { value: 'scan_blocked', key: 'filter.scanBlocked' },
];

/**
 * Le journal des runs. Une ligne par run ; un clic ouvre son aperçu (étapes,
 * scans, contexte), la trace complète reste la page du run.
 */
export function DeploymentsTable({
  items,
  page,
  filter,
  search,
  canPurge,
  canRollback,
  format,
}: {
  items: DeploymentRow[];
  page: { page: number; totalPages: number; pageSize: number; total: number };
  filter: StatusFilter;
  /** La recherche en cours, telle que l'URL la porte. */
  search: string;
  canPurge: boolean;
  canRollback: boolean;
  /** Le formatage descend par props : la table est cliente, la locale non. */
  format: FormatSettings;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [preview, setPreview] = useState<PurgeReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const drawer = useDrawerSelection(
    'run',
    items.map((item) => item.id),
  );
  const current = items.find((item) => item.id === drawer.selected) ?? null;

  const selectable = useMemo(() => items.filter((item) => !item.purgeBlocked), [items]);
  const blocked = items.length - selectable.length;
  const selectedRows = useMemo(
    () => items.filter((item) => selected.has(item.id)),
    [items, selected],
  );

  const allSelected = selectable.length > 0 && selectable.every((item) => selected.has(item.id));
  const someSelected = selected.size > 0 && !allSelected;

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll(checked: boolean) {
    setSelected(checked ? new Set(selectable.map((item) => item.id)) : new Set());
  }

  /** Le décompte montré dans la confirmation vient du serveur, pas du tableau. */
  async function openConfirm() {
    setError(null);
    setPreview(null);
    setConfirmOpen(true);
    setPending(true);

    const report = await callPurge([...selected], true);
    setPending(false);
    if (report) setPreview(report);
  }

  async function confirmPurge() {
    setPending(true);
    const report = await callPurge([...selected], false);
    setPending(false);
    if (!report) return;

    setConfirmOpen(false);
    setSelected(new Set());
    toast({ title: summarise(t, report), tone: report.refusedCount > 0 ? 'warn' : 'ok' });
    router.refresh();
  }

  async function callPurge(ids: string[], dryRun: boolean): Promise<PurgeReport | null> {
    const response = await fetch('/api/deployments/purge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids, dryRun }),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      setError(body.error?.message ?? tc('http.failure', { status: response.status }));
      return null;
    }

    return (await response.json()) as PurgeReport;
  }

  const hrefFor = (next: { status?: StatusFilter; search?: string; page?: number }) => {
    const params = filterParams(
      next.status === undefined ? filter : next.status,
      next.search === undefined ? search : next.search,
    );
    const target = next.page ?? 1;
    if (target > 1) params.set('page', String(target));
    if (page.pageSize !== 25) params.set('pageSize', String(page.pageSize));
    const query = params.toString();
    return query ? `/deployments?${query}` : '/deployments';
  };

  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle px-4 py-3">
        <form
          role="search"
          className="w-full sm:w-[260px]"
          onSubmit={(event) => {
            event.preventDefault();
            const value = String(new FormData(event.currentTarget).get('q') ?? '').trim();
            router.push(hrefFor({ search: value, page: 1 }) as never, { scroll: false });
          }}
        >
          <label className="affix w-full">
            <Search aria-hidden />
            <input
              // Une nouvelle recherche venue de l'URL (lien, retour arrière)
              // remplace la saisie : la clé remonte le champ.
              key={search}
              type="search"
              name="q"
              className="input input-sm"
              defaultValue={search}
              maxLength={100}
              placeholder={t('search.placeholder')}
              aria-label={t('search.label')}
            />
          </label>
        </form>
        <nav aria-label={t('filter.label')} className="flex flex-wrap items-center gap-2">
          {FILTERS.map((option) => (
            <FilterChipLink
              key={option.key}
              href={hrefFor({ status: option.value, page: 1 }) as never}
              active={filter === option.value}
              scroll={false}
            >
              {t(option.key)}
            </FilterChipLink>
          ))}
        </nav>
        <span className="t-cap mono ml-auto text-text-3 tabular-nums">
          {t('page.counter', { count: page.total, page: page.page, total: page.totalPages })}
        </span>
      </div>

      {canPurge && selected.size > 0 ? (
        <div className="flex flex-wrap items-center gap-3 border-b border-accent-line bg-accent-soft px-4 py-2.5">
          <Checkbox
            aria-label={t('table.uncheckAll')}
            checked={allSelected}
            indeterminate={someSelected}
            onChange={() => setSelected(new Set())}
          />
          <span className="t-sm font-semibold text-text">
            {t('table.selected', { count: selected.size })}
          </span>
          <span className="t-cap text-text-3">
            {t('table.selectionNote')}
            {blocked > 0 ? ` ${t('table.blocked', { count: blocked })}` : ''}
          </span>
          <span className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              {t('table.uncheckAll')}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={pending}
              onClick={() => void openConfirm()}
            >
              <Trash2 aria-hidden />
              {t('table.purgeSelection')}
            </Button>
          </span>
        </div>
      ) : null}

      {error ? (
        <div className="border-b border-border-subtle px-4 py-3">
          <Alert variant="destructive">{error}</Alert>
        </div>
      ) : null}

      {items.length === 0 ? (
        <p className="t-sm px-4 py-6 text-text-3">{t('filter.empty')}</p>
      ) : (
        <Table label={t('page.title')}>
          <TableHeader>
            <TableRow>
              {canPurge ? (
                <TableHead className="w-10">
                  <Checkbox
                    aria-label={tc('selectAll')}
                    checked={allSelected}
                    indeterminate={someSelected}
                    disabled={selectable.length === 0}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                      toggleAll(event.target.checked)
                    }
                  />
                </TableHead>
              ) : null}
              <TableHead>{t('column.run')}</TableHead>
              <TableHead>{t('column.application')}</TableHead>
              <TableHead>{tc('column.target')}</TableHead>
              <TableHead>{t('column.runtime')}</TableHead>
              <TableHead>{t('column.scans')}</TableHead>
              <TableHead>{tc('column.status')}</TableHead>
              <TableHead className="r">{tc('column.duration')}</TableHead>
              <TableHead>{t('column.date')}</TableHead>
              <TableHead>{t('column.by')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow
                key={item.id}
                interactive
                selected={selected.has(item.id) || drawer.selected === item.id}
                onClick={() => drawer.open(item.id)}
              >
                {canPurge ? (
                  <TableCell onClick={(event) => event.stopPropagation()}>
                    {item.purgeBlocked ? (
                      // Une case désactivée dit pourquoi, au survol comme au
                      // focus ; la barre de sélection le répète en clair.
                      <Tooltip content={t('row.purgeBlocked')}>
                        <span
                          tabIndex={0}
                          className="inline-flex rounded-sm outline-none focus-visible:shadow-focus"
                        >
                          <Checkbox
                            aria-label={t('row.select', {
                              slug: item.applicationSlug,
                              number: item.number,
                            })}
                            disabled
                          />
                        </span>
                      </Tooltip>
                    ) : (
                      <Checkbox
                        aria-label={t('row.select', {
                          slug: item.applicationSlug,
                          number: item.number,
                        })}
                        checked={selected.has(item.id)}
                        onChange={() => toggle(item.id)}
                      />
                    )}
                  </TableCell>
                ) : null}
                <TableCell className="mono text-text-3">#{item.number}</TableCell>
                <TableCell>
                  <button
                    type="button"
                    className="cellname text-left hover:underline"
                    aria-label={t('row.open', {
                      slug: item.applicationSlug,
                      number: item.number,
                    })}
                    onClick={(event) => {
                      event.stopPropagation();
                      drawer.open(item.id);
                    }}
                  >
                    {item.applicationSlug}
                  </button>
                </TableCell>
                <TableCell className="mono">{item.targetName}</TableCell>
                <TableCell>
                  <CodeBadge>{item.runtime}</CodeBadge>
                </TableCell>
                <TableCell>
                  <ScanCell scan={item.scan} />
                </TableCell>
                <TableCell>
                  <DeploymentStatusBadge status={item.status} />
                </TableCell>
                <TableCell className="r num" suppressHydrationWarning>
                  {formatDuration(item.startedAt, item.finishedAt)}
                </TableCell>
                <TableCell className="mono whitespace-nowrap text-text-2">
                  {formatDate(item.createdAt, format)}
                </TableCell>
                <TableCell className="t-cap text-text-2">
                  {item.triggeredByEmail?.split('@')[0] ?? tc('none')}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <div className="pager">
        <span>{t('pager.timezone')}</span>
        {page.totalPages > 1 ? (
          <span className="ml-auto flex items-center gap-2">
            {page.page > 1 ? (
              <Button asChild size="sm" variant="secondary">
                <Link href={hrefFor({ page: page.page - 1 }) as never}>
                  <ChevronLeft aria-hidden />
                  {tc('page.previous')}
                </Link>
              </Button>
            ) : (
              <Button size="sm" variant="secondary" disabled>
                <ChevronLeft aria-hidden />
                {tc('page.previous')}
              </Button>
            )}
            <span className="num">
              {tc('page.position', { page: page.page, total: page.totalPages })}
            </span>
            {page.page < page.totalPages ? (
              <Button asChild size="sm" variant="secondary">
                <Link href={hrefFor({ page: page.page + 1 }) as never}>
                  {tc('page.next')}
                  <ChevronRight aria-hidden />
                </Link>
              </Button>
            ) : (
              <Button size="sm" variant="secondary" disabled>
                {tc('page.next')}
                <ChevronRight aria-hidden />
              </Button>
            )}
          </span>
        ) : null}
      </div>

      <RunDrawer
        row={current}
        onOpenChange={(open) => (open ? undefined : drawer.close())}
        onPrevious={drawer.onPrevious}
        onNext={drawer.onNext}
        canRollback={canRollback}
        format={format}
      />

      <PurgeDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        pending={pending}
        preview={preview}
        rows={selectedRows}
        onConfirm={() => void confirmPurge()}
      />
    </section>
  );
}

/**
 * Confirmation qui **nomme** ce qui disparaît : combien de runs, lesquels,
 * quels ports rendus, quelles applications perdent leur repli. « Êtes-vous
 * sûr ? » n'apprend rien à personne.
 */
function PurgeDialog({
  open,
  onOpenChange,
  pending,
  preview,
  rows,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  preview: PurgeReport | null;
  rows: DeploymentRow[];
  onConfirm: () => void;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const count = preview?.purgedCount ?? rows.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent role="alertdialog">
        <DialogHeader icon={<Trash2 />}>
          <DialogTitle>{t('purge.dialogTitle', { count })}</DialogTitle>
        </DialogHeader>

        <DialogBody>
          <p>
            <strong>{t('purge.description')}</strong>
          </p>
          {preview === null ? (
            <p className="text-text-3">{t('purge.computing')}</p>
          ) : (
            <>
              <ul className="bul flex flex-col gap-1.5">
                <li>
                  <span className="mono">{preview.purgedCount}</span>{' '}
                  {t('purge.erased', {
                    count: preview.purgedCount,
                    total: rows.length,
                    selected: t('purge.selectedWord', { count: rows.length }),
                  })}{' '}
                  <span className="text-text-3">
                    {rows
                      .slice(0, 6)
                      .map((row) => `#${row.number} ${row.applicationSlug}`)
                      .join(', ')}
                    {rows.length > 6 ? '…' : ''}
                  </span>
                </li>
                {preview.releasedPorts.length > 0 ? (
                  <li>
                    {t('purge.releasedPorts', {
                      count: preview.releasedPorts.length,
                      list: preview.releasedPorts
                        .map((entry) => `${entry.port} (${entry.targetName})`)
                        .join(', '),
                    })}
                  </li>
                ) : null}
                {preview.rollbackTargetsLost > 0 ? (
                  <li>{t('purge.rollbackLost', { count: preview.rollbackTargetsLost })}</li>
                ) : null}
              </ul>

              {preview.refusedCount > 0 ? (
                <Alert
                  variant="destructive"
                  title={t('purge.refused', { count: preview.refusedCount })}
                >
                  <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-4">
                    {preview.refused.map((refusal) => (
                      <li key={refusal.id}>{refusal.message}</li>
                    ))}
                  </ul>
                </Alert>
              ) : null}

              {preview.truncated ? (
                <Alert variant="warn">{t('purge.truncated', { limit: preview.limit })}</Alert>
              ) : null}

              <p className="t-cap text-text-3">{t('purge.auditNote')}</p>
            </>
          )}
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {tc('cancel')}
          </Button>
          <Button
            variant="destructive"
            loading={pending}
            disabled={preview === null || preview.purgedCount === 0}
            onClick={onConfirm}
          >
            {pending
              ? t('purge.pending')
              : t('purge.confirm', { count: preview?.purgedCount ?? 0 })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Le toast qui suit une purge. Les trois morceaux sont assemblés ici et non
 * dans une seule phrase du dictionnaire : deux d'entre eux sont facultatifs, et
 * une phrase à trous optionnels ne se traduit pas.
 */
function summarise(t: Translate<typeof messages.fr>, report: PurgeReport): string {
  const parts = [t('purge.summary.purged', { count: report.purgedCount })];
  if (report.refusedCount > 0) {
    parts.push(t('purge.summary.refused', { count: report.refusedCount }));
  }
  if (report.releasedPorts.length > 0) {
    parts.push(
      t('purge.summary.ports', {
        count: report.releasedPorts.length,
        list: report.releasedPorts.map((entry) => entry.port).join(', '),
      }),
    );
  }
  return parts.join(' · ');
}

/** La pire sévérité relevée, et combien : ce que la colonne Scans montre. */
export function worstOf(counts: SeverityCounts) {
  const worst = SEVERITY_ORDER.find((severity) => counts[severity] > 0) ?? null;
  return worst ? { severity: worst, count: counts[worst] } : null;
}

/** Colonne « Scans » : le verdict d'ensemble, et la pire sévérité relevée. */
function ScanCell({ scan }: { scan: DeploymentRow['scan'] }) {
  const tc = useT(common);

  if (!scan || scan.scanners.length === 0) {
    return <span className="text-text-3">{tc('none')}</span>;
  }

  const worst = worstOf(scan.counts);

  return (
    <span className="flex items-center gap-1.5">
      <VerdictBadge verdict={scan.verdict} />
      {worst ? (
        <span className="mono text-[11.5px] whitespace-nowrap text-text-3">
          {worst.severity} ×{worst.count}
        </span>
      ) : null}
    </span>
  );
}

export function VerdictBadge({ verdict }: { verdict: ScanVerdict | null }) {
  const t = useT(messages);
  if (verdict === 'fail') return <Badge variant="danger">{t('verdict.fail')}</Badge>;
  if (verdict === 'pass') return <Badge variant="ok">{t('verdict.pass')}</Badge>;
  return <Badge variant="warn">{t('verdict.unknown')}</Badge>;
}
