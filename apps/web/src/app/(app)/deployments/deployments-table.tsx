'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { useMemo, useState } from 'react';
import {
  SCANNERS,
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
import { Card, CardContent, CardFooter } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { deployments as messages } from '@/i18n/messages/deployments';
import type { FormatSettings } from '@/lib/format';
import {
  DeploymentStatusBadge,
  formatDate,
  formatDuration,
  useDeploymentLabels,
} from './status-badge';

export type DeploymentRow = {
  id: string;
  status: DeploymentStatus;
  runtime: 'docker' | 'k3s';
  version: number;
  url: string | null;
  applicationSlug: string;
  targetName: string;
  triggeredByEmail: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  /**
   * Ce run est la version en service sur sa cible — ou il tourne encore.
   * Dans les deux cas il ne se purge pas : c'est le serveur qui tranche, la
   * case grisée ne fait qu'éviter d'annoncer un geste qui sera refusé.
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

export function DeploymentsTable({
  items,
  page,
  canPurge,
  format,
}: {
  items: DeploymentRow[];
  page: { page: number; totalPages: number; pageSize: number };
  canPurge: boolean;
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
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const selectable = useMemo(() => items.filter((item) => !item.purgeBlocked), [items]);
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
    setNotice(null);
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
    setNotice(summarise(t, report));
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
      setConfirmOpen(false);
      return null;
    }

    return (await response.json()) as PurgeReport;
  }

  return (
    <Card className="py-4">
      <CardContent className="flex flex-col gap-3">
        {error ? <Alert variant="destructive">{error}</Alert> : null}
        {notice ? <Alert variant="success">{notice}</Alert> : null}

        {canPurge ? (
          <div className="flex min-h-8 items-center justify-between gap-3">
            <span className="font-mono text-xs text-text-3 tabular-nums">
              {selected.size === 0
                ? t('table.selectHint')
                : t('table.selected', { count: selected.size })}
            </span>
            <div className="flex items-center gap-2">
              {selected.size > 0 ? (
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                  {t('table.uncheckAll')}
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="destructive"
                disabled={selected.size === 0 || pending}
                onClick={() => void openConfirm()}
              >
                {t('table.purgeSelection')}
              </Button>
            </div>
          </div>
        ) : null}

        <Table>
          <TableHeader>
            <TableRow>
              {canPurge ? (
                <TableHead className="w-8">
                  <Checkbox
                    aria-label={tc('selectAll')}
                    checked={allSelected}
                    indeterminate={someSelected}
                    disabled={selectable.length === 0}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>) => toggleAll(event.target.checked)}
                  />
                </TableHead>
              ) : null}
              <TableHead>{t('column.application')}</TableHead>
              <TableHead>{tc('column.target')}</TableHead>
              <TableHead>{t('column.runtime')}</TableHead>
              {/*
                Largeur minimale : la cellule contient un verdict, trois noms de
                scanner et un décompte. En mise en page automatique, c'est la
                seule colonne qui sait passer à la ligne, donc celle que le
                navigateur écrase en premier — les cinq pastilles s'empilaient
                verticalement et chaque ligne du journal faisait 150 px de haut.
              */}
              <TableHead className="min-w-56">{t('column.scans')}</TableHead>
              <TableHead>{tc('column.status')}</TableHead>
              <TableHead>{tc('column.duration')}</TableHead>
              <TableHead>{t('column.date')}</TableHead>
              <TableHead>{t('column.by')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow key={item.id} data-selected={selected.has(item.id) || undefined}>
                {canPurge ? (
                  <TableCell>
                    <Checkbox
                      aria-label={t('row.select', {
                        slug: item.applicationSlug,
                        version: item.version,
                      })}
                      checked={selected.has(item.id)}
                      disabled={item.purgeBlocked}
                      title={item.purgeBlocked ? t('row.purgeBlocked') : undefined}
                      onChange={() => toggle(item.id)}
                    />
                  </TableCell>
                ) : null}
                <TableCell>
                  <Link
                    href={`/deployments/${item.id}`}
                    className="text-[0.8125rem] font-medium text-text underline decoration-transparent underline-offset-4 transition-colors hover:decoration-accent-line"
                  >
                    {item.applicationSlug}
                  </Link>
                  <div className="font-mono text-[0.6875rem] text-text-3">v{item.version}</div>
                </TableCell>
                <TableCell className="font-mono text-xs text-text-2">{item.targetName}</TableCell>
                <TableCell>
                  <CodeBadge>{item.runtime}</CodeBadge>
                </TableCell>
                <TableCell>
                  <ScanCell scan={item.scan} />
                </TableCell>
                <TableCell>
                  <DeploymentStatusBadge status={item.status} />
                </TableCell>
                <TableCell className="font-mono text-xs text-text-2 tabular-nums">
                  {formatDuration(item.startedAt, item.finishedAt)}
                </TableCell>
                <TableCell className="font-mono text-xs whitespace-nowrap text-text-2 tabular-nums">
                  {formatDate(item.createdAt, format)}
                </TableCell>
                <TableCell className="text-xs text-text-3">
                  {item.triggeredByEmail ?? tc('none')}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

      </CardContent>

      {page.totalPages > 1 ? (
        <CardFooter className="flex items-center justify-between text-xs">
          <span className="font-mono text-text-3 tabular-nums">
            {tc('page.position', { page: page.page, total: page.totalPages })}
          </span>
          <div className="flex gap-4">
            {page.page > 1 ? (
              <Link
                href={`/deployments?page=${page.page - 1}&pageSize=${page.pageSize}`}
                className="text-text-2 transition-colors hover:text-accent"
              >
                {tc('page.previous')}
              </Link>
            ) : null}
            {page.page < page.totalPages ? (
              <Link
                href={`/deployments?page=${page.page + 1}&pageSize=${page.pageSize}`}
                className="text-text-2 transition-colors hover:text-accent"
              >
                {tc('page.next')}
              </Link>
            ) : null}
          </div>
        </CardFooter>
      ) : null}

      <PurgeDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        pending={pending}
        preview={preview}
        rows={selectedRows}
        onConfirm={() => void confirmPurge()}
      />
    </Card>
  );
}

/**
 * Confirmation qui **nomme** ce qui disparaît : combien de runs, dans quels
 * statuts, quels ports rendus. « Êtes-vous sûr ? » n'apprend rien à personne.
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
  const label = useDeploymentLabels();
  const statuses = preview ? Object.entries(preview.purgedByStatus) : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('purge.title')}</DialogTitle>
          <DialogDescription>{t('purge.description')}</DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-3 text-[0.8125rem]">
          {preview === null ? (
            <p className="text-text-2">{t('purge.computing')}</p>
          ) : (
            <>
              <p className="text-text">
                <strong className="font-mono tabular-nums">{preview.purgedCount}</strong>{' '}
                {t('purge.erased', {
                  count: preview.purgedCount,
                  total: rows.length,
                  selected: t('purge.selectedWord', { count: rows.length }),
                })}
              </p>

              {statuses.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  {statuses.map(([status, total]) => (
                    <CodeBadge key={status}>
                      {label[status as DeploymentStatus] ?? status} ×{total}
                    </CodeBadge>
                  ))}
                </div>
              ) : null}

              {preview.releasedPorts.length > 0 ? (
                <Alert variant="info">
                  {t('purge.releasedPorts', {
                    count: preview.releasedPorts.length,
                    list: preview.releasedPorts
                      .map((entry) => `${entry.port} (${entry.targetName})`)
                      .join(', '),
                  })}
                </Alert>
              ) : null}

              {preview.rollbackTargetsLost > 0 ? (
                <Alert variant="warn">
                  {t('purge.rollbackLost', { count: preview.rollbackTargetsLost })}
                </Alert>
              ) : null}

              {preview.refusedCount > 0 ? (
                <Alert variant="destructive">
                  <p className="font-medium">
                    {t('purge.refused', { count: preview.refusedCount })}
                  </p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4">
                    {preview.refused.map((refusal) => (
                      <li key={refusal.id}>{refusal.message}</li>
                    ))}
                  </ul>
                </Alert>
              ) : null}

              {preview.truncated ? (
                <Alert variant="warn">{t('purge.truncated', { limit: preview.limit })}</Alert>
              ) : null}

              <p className="text-text-3">{t('purge.auditNote')}</p>
            </>
          )}
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {tc('cancel')}
          </Button>
          <Button
            variant="destructive"
            disabled={pending || preview === null || preview.purgedCount === 0}
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
 * Le bandeau qui suit une purge. Les trois morceaux sont assemblés ici et non
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
  return `${parts.join(' · ')}.`;
}

/**
 * Colonne « Scans » : quels outils ont tourné, et le verdict d'ensemble.
 * Les libellés viennent de `SCANNERS` — aucun scanner n'est nommé ici.
 */
function ScanCell({ scan }: { scan: DeploymentRow['scan'] }) {
  const t = useT(messages);
  const tc = useT(common);

  if (!scan || scan.scanners.length === 0) {
    return <span className="text-xs text-text-3">{tc('none')}</span>;
  }

  const worst = SEVERITY_ORDER.find((severity) => scan.counts[severity] > 0) ?? null;

  return (
    <div className="flex flex-wrap items-center gap-1">
      {scan.verdict === 'fail' ? (
        <Badge variant="destructive">{t('verdict.fail')}</Badge>
      ) : scan.verdict === 'unknown' ? (
        <Badge variant="warn">{t('verdict.unknown')}</Badge>
      ) : (
        <Badge variant="ok">{t('verdict.pass')}</Badge>
      )}
      {scan.scanners.map((key) => (
        <CodeBadge key={key}>{SCANNERS[key].label}</CodeBadge>
      ))}
      {worst ? (
        <span className="font-mono text-[0.6875rem] text-text-3 tabular-nums">
          {worst} ×{scan.counts[worst]}
        </span>
      ) : null}
    </div>
  );
}
