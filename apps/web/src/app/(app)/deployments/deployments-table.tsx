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
} from '@tp/core';
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
import { DEPLOYMENT_LABEL, DeploymentStatusBadge, formatDate, formatDuration } from './status-badge';

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
}: {
  items: DeploymentRow[];
  page: { page: number; totalPages: number; pageSize: number };
  canPurge: boolean;
}) {
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
    setNotice(summarise(report));
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
      setError(body.error?.message ?? `Échec (HTTP ${response.status})`);
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
            <span className="font-mono text-xs text-ink-faint tabular-nums">
              {selected.size === 0
                ? 'Cochez des runs pour les effacer de l’historique.'
                : `${selected.size} run${selected.size > 1 ? 's' : ''} sélectionné${selected.size > 1 ? 's' : ''}`}
            </span>
            <div className="flex items-center gap-2">
              {selected.size > 0 ? (
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                  Tout décocher
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="destructive"
                disabled={selected.size === 0 || pending}
                onClick={() => void openConfirm()}
              >
                Purger la sélection
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
                    aria-label="Tout sélectionner"
                    checked={allSelected}
                    indeterminate={someSelected}
                    disabled={selectable.length === 0}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>) => toggleAll(event.target.checked)}
                  />
                </TableHead>
              ) : null}
              <TableHead>Application</TableHead>
              <TableHead>Cible</TableHead>
              <TableHead>Runtime</TableHead>
              {/*
                Largeur minimale : la cellule contient un verdict, trois noms de
                scanner et un décompte. En mise en page automatique, c'est la
                seule colonne qui sait passer à la ligne, donc celle que le
                navigateur écrase en premier — les cinq pastilles s'empilaient
                verticalement et chaque ligne du journal faisait 150 px de haut.
              */}
              <TableHead className="min-w-56">Scans</TableHead>
              <TableHead>Statut</TableHead>
              <TableHead>Durée</TableHead>
              <TableHead>Date (UTC)</TableHead>
              <TableHead>Par</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow key={item.id} data-selected={selected.has(item.id) || undefined}>
                {canPurge ? (
                  <TableCell>
                    <Checkbox
                      aria-label={`Sélectionner ${item.applicationSlug} v${item.version}`}
                      checked={selected.has(item.id)}
                      disabled={item.purgeBlocked}
                      title={
                        item.purgeBlocked
                          ? 'En service ou en cours : détruisez-le avant de le purger.'
                          : undefined
                      }
                      onChange={() => toggle(item.id)}
                    />
                  </TableCell>
                ) : null}
                <TableCell>
                  <Link
                    href={`/deployments/${item.id}`}
                    className="text-[0.8125rem] font-medium text-ink underline decoration-transparent underline-offset-4 transition-colors hover:decoration-signal-edge"
                  >
                    {item.applicationSlug}
                  </Link>
                  <div className="font-mono text-[0.6875rem] text-ink-faint">v{item.version}</div>
                </TableCell>
                <TableCell className="font-mono text-xs text-ink-muted">{item.targetName}</TableCell>
                <TableCell>
                  <CodeBadge>{item.runtime}</CodeBadge>
                </TableCell>
                <TableCell>
                  <ScanCell scan={item.scan} />
                </TableCell>
                <TableCell>
                  <DeploymentStatusBadge status={item.status} />
                </TableCell>
                <TableCell className="font-mono text-xs text-ink-muted tabular-nums">
                  {formatDuration(item.startedAt, item.finishedAt)}
                </TableCell>
                <TableCell className="font-mono text-xs whitespace-nowrap text-ink-muted tabular-nums">
                  {formatDate(item.createdAt)}
                </TableCell>
                <TableCell className="text-xs text-ink-faint">
                  {item.triggeredByEmail ?? '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

      </CardContent>

      {page.totalPages > 1 ? (
        <CardFooter className="flex items-center justify-between text-xs">
          <span className="font-mono text-ink-faint tabular-nums">
            Page {page.page} sur {page.totalPages}
          </span>
          <div className="flex gap-4">
            {page.page > 1 ? (
              <Link
                href={`/deployments?page=${page.page - 1}&pageSize=${page.pageSize}`}
                className="text-ink-muted transition-colors hover:text-signal"
              >
                ← Précédente
              </Link>
            ) : null}
            {page.page < page.totalPages ? (
              <Link
                href={`/deployments?page=${page.page + 1}&pageSize=${page.pageSize}`}
                className="text-ink-muted transition-colors hover:text-signal"
              >
                Suivante →
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
  const statuses = preview ? Object.entries(preview.purgedByStatus) : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Purger l’historique</DialogTitle>
          <DialogDescription>
            La purge efface la trace en base. Elle ne touche à rien sur la machine cible.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-3 text-[0.8125rem]">
          {preview === null ? (
            <p className="text-ink-muted">Calcul de ce qui sera effacé…</p>
          ) : (
            <>
              <p className="text-ink">
                <strong className="font-mono tabular-nums">{preview.purgedCount}</strong> run
                {preview.purgedCount > 1 ? 's' : ''} sur {rows.length} sélectionné
                {rows.length > 1 ? 's' : ''} {preview.purgedCount > 1 ? 'seront effacés' : 'sera effacé'},
                avec leurs étapes, leurs logs et leurs scans.
              </p>

              {statuses.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  {statuses.map(([status, total]) => (
                    <CodeBadge key={status}>
                      {DEPLOYMENT_LABEL[status as DeploymentStatus] ?? status} ×{total}
                    </CodeBadge>
                  ))}
                </div>
              ) : null}

              {preview.releasedPorts.length > 0 ? (
                <Alert variant="info">
                  Port{preview.releasedPorts.length > 1 ? 's' : ''} rendu
                  {preview.releasedPorts.length > 1 ? 's' : ''} à leur cible :{' '}
                  {preview.releasedPorts
                    .map((entry) => `${entry.port} (${entry.targetName})`)
                    .join(', ')}
                  .
                </Alert>
              ) : null}

              {preview.rollbackTargetsLost > 0 ? (
                <Alert variant="warn">
                  {preview.rollbackTargetsLost} run{preview.rollbackTargetsLost > 1 ? 's' : ''}{' '}
                  perdra sa version de repli : le rollback ne sera plus proposé.
                </Alert>
              ) : null}

              {preview.refusedCount > 0 ? (
                <Alert variant="destructive">
                  <p className="font-medium">
                    {preview.refusedCount} refusé{preview.refusedCount > 1 ? 's' : ''} :
                  </p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4">
                    {preview.refused.map((refusal) => (
                      <li key={refusal.id}>{refusal.message}</li>
                    ))}
                  </ul>
                </Alert>
              ) : null}

              {preview.truncated ? (
                <Alert variant="warn">
                  Sélection tronquée à {preview.limit} runs par appel. Relancez la purge pour
                  finir.
                </Alert>
              ) : null}

              <p className="text-ink-faint">
                Les logs d’activité, eux, conservent la trace de ce qui a été purgé.
              </p>
            </>
          )}
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Annuler
          </Button>
          <Button
            variant="destructive"
            disabled={pending || preview === null || preview.purgedCount === 0}
            onClick={onConfirm}
          >
            {pending
              ? 'Purge…'
              : `Purger ${preview?.purgedCount ?? 0} run${(preview?.purgedCount ?? 0) > 1 ? 's' : ''}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function summarise(report: PurgeReport): string {
  const parts = [`${report.purgedCount} run${report.purgedCount > 1 ? 's' : ''} purgé${report.purgedCount > 1 ? 's' : ''}`];
  if (report.refusedCount > 0) parts.push(`${report.refusedCount} refusé${report.refusedCount > 1 ? 's' : ''}`);
  if (report.releasedPorts.length > 0) {
    parts.push(
      `port${report.releasedPorts.length > 1 ? 's' : ''} libéré${report.releasedPorts.length > 1 ? 's' : ''} : ${report.releasedPorts.map((entry) => entry.port).join(', ')}`,
    );
  }
  return `${parts.join(' · ')}.`;
}

/**
 * Colonne « Scans » : quels outils ont tourné, et le verdict d'ensemble.
 * Les libellés viennent de `SCANNERS` — aucun scanner n'est nommé ici.
 */
function ScanCell({ scan }: { scan: DeploymentRow['scan'] }) {
  if (!scan || scan.scanners.length === 0) {
    return <span className="text-xs text-ink-faint">—</span>;
  }

  const worst = SEVERITY_ORDER.find((severity) => scan.counts[severity] > 0) ?? null;

  return (
    <div className="flex flex-wrap items-center gap-1">
      {scan.verdict === 'fail' ? (
        <Badge variant="destructive">bloquant</Badge>
      ) : scan.verdict === 'unknown' ? (
        <Badge variant="warn">indéterminé</Badge>
      ) : (
        <Badge variant="ok">conforme</Badge>
      )}
      {scan.scanners.map((key) => (
        <CodeBadge key={key}>{SCANNERS[key].label}</CodeBadge>
      ))}
      {worst ? (
        <span className="font-mono text-[0.6875rem] text-ink-faint tabular-nums">
          {worst} ×{scan.counts[worst]}
        </span>
      ) : null}
    </div>
  );
}
