'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw, Trash2, ArrowUpCircle, Lock } from 'lucide-react';
import type { ServiceState, Workload } from '@tp/core';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableActions,
  TableActionsHead,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

/**
 * Ce qui tourne sur la cible, panel compris.
 *
 * Le mot « charge » ne s'affiche nulle part : chaque ligne se nomme comme son
 * runtime la nomme — « conteneur », « deployment », « pod » — parce que c'est le
 * driver qui a rempli le champ `kind`. L'interface parle donc la langue de la
 * machine sans que le code n'ait à deviner de quel runtime il s'agit.
 */

type WorkloadRow = Workload & { ref: string };

type RuntimeReport = {
  runtime: 'docker' | 'k3s';
  ok: boolean;
  error: string | null;
  count: number;
};

type Inventory = {
  checkedAt: string;
  runtimes: RuntimeReport[];
  items: WorkloadRow[];
  total: number;
  managed: number;
};

type ApiError = { error?: { message?: string } };

type Progress = { ref: string; name: string; lines: string[]; done: boolean; failed: boolean };

const STATE_LABEL: Record<ServiceState, string> = {
  running: 'en marche',
  restarting: 'redémarre',
  exited: 'arrêtée',
  paused: 'en pause',
  created: 'créée',
  unknown: 'inconnu',
};

const STATE_TONE: Record<ServiceState, string> = {
  running: 'bg-ok',
  restarting: 'bg-warn',
  exited: 'bg-ink-faint',
  paused: 'bg-warn',
  created: 'bg-warn',
  unknown: 'bg-ink-faint',
};

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toISOString().slice(0, 16).replace('T', ' ');
}

export function WorkloadsPanel({
  targetId,
  canManage,
}: {
  targetId: string;
  canManage: boolean;
}) {
  const router = useRouter();
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const source = useRef<EventSource | null>(null);

  /** Interrogation nue : elle ne touche à aucun état, pour rester appelable
   *  depuis un effet sans déclencher de rendu en cascade. */
  const fetchInventory = useCallback(async (): Promise<Inventory> => {
    const response = await fetch(`/api/targets/${targetId}/workloads`, { cache: 'no-store' });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      throw new Error(body.error?.message ?? `Inventaire impossible (HTTP ${response.status})`);
    }
    return (await response.json()) as Inventory;
  }, [targetId]);

  const apply = useCallback((result: Inventory | Error) => {
    if (result instanceof Error) {
      setError(result.message);
      setInventory(null);
    } else {
      setInventory(result);
    }
    setLoading(false);
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      apply(await fetchInventory());
    } catch (cause) {
      apply(cause instanceof Error ? cause : new Error('Inventaire impossible'));
    }
  }, [apply, fetchInventory]);

  // Premier chargement : les mises à jour d'état n'ont lieu que dans les
  // rappels de la promesse, jamais dans le corps de l'effet.
  useEffect(() => {
    let cancelled = false;
    fetchInventory().then(
      (result) => {
        if (!cancelled) apply(result);
      },
      (cause: unknown) => {
        if (!cancelled) apply(cause instanceof Error ? cause : new Error('Inventaire impossible'));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [apply, fetchInventory]);

  const closeStream = useCallback(() => {
    source.current?.close();
    source.current = null;
  }, []);

  useEffect(() => closeStream, [closeStream]);

  /**
   * Ouvre le flux **avant** d'enfiler la tâche : s'abonner après, c'est perdre
   * les premières lignes d'une opération qui démarre en une fraction de seconde.
   */
  const openStream = useCallback(
    (ref: string, name: string) =>
      new Promise<void>((resolve) => {
        closeStream();
        setProgress({ ref, name, lines: [], done: false, failed: false });

        const stream = new EventSource(`/api/targets/${targetId}/workloads/events`);
        source.current = stream;

        stream.addEventListener('ready', () => resolve());
        stream.addEventListener('log', (event) => {
          const payload = JSON.parse((event as MessageEvent<string>).data) as {
            ref: string;
            line: string;
          };
          if (payload.ref !== ref) return;
          setProgress((current) =>
            current ? { ...current, lines: [...current.lines, payload.line].slice(-200) } : current,
          );
        });
        stream.addEventListener('lifecycle', (event) => {
          const payload = JSON.parse((event as MessageEvent<string>).data) as {
            ref: string;
            status: 'started' | 'succeeded' | 'failed';
            detail: string | null;
          };
          if (payload.ref !== ref || payload.status === 'started') return;

          const failed = payload.status === 'failed';
          setProgress((current) =>
            current
              ? {
                  ...current,
                  done: true,
                  failed,
                  lines: failed && payload.detail ? [...current.lines, payload.detail] : current.lines,
                }
              : current,
          );
          if (failed) setError(payload.detail ?? "L'opération a échoué");
          closeStream();
          setBusy(null);
          void reload();
          router.refresh();
        });
        stream.onerror = () => resolve();
      }),
    [closeStream, reload, router, targetId],
  );

  async function act(workload: WorkloadRow, action: 'remove' | 'update') {
    const noun = workload.kind;
    const question =
      action === 'remove'
        ? `Supprimer le ${noun} « ${workload.name} » de cette machine ?\n\n` +
          `Image : ${workload.image ?? 'inconnue'}\n` +
          'Cette suppression est définitive. Les volumes nommés, eux, sont conservés.'
        : `Mettre à jour le ${noun} « ${workload.name} » ?\n\n` +
          `L'image ${workload.image ?? 'inconnue'} est retirée à sa version la plus récente, ` +
          'puis la charge est recréée avec la même configuration. Elle sera brièvement indisponible.';

    if (!window.confirm(question)) return;

    setBusy(workload.ref);
    setError(null);
    await openStream(workload.ref, workload.name);

    const url =
      action === 'remove'
        ? `/api/targets/${targetId}/workloads/${encodeURIComponent(workload.ref)}`
        : `/api/targets/${targetId}/workloads/${encodeURIComponent(workload.ref)}/update`;

    const response = await fetch(url, { method: action === 'remove' ? 'DELETE' : 'POST' });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      setError(body.error?.message ?? `Échec (HTTP ${response.status})`);
      setBusy(null);
      setProgress(null);
      closeStream();
    }
  }

  const items = inventory?.items ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="space-y-1.5">
          <CardTitle>Ce qui tourne sur cette machine</CardTitle>
          <CardDescription>
            {inventory
              ? `${inventory.total} charge${inventory.total > 1 ? 's' : ''}, dont ${inventory.managed} déployée${inventory.managed > 1 ? 's' : ''} par le panel · relevé du ${formatDate(inventory.checkedAt)}`
              : 'Inventaire pris en direct sur la machine, par le worker.'}
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => void reload()} disabled={loading}>
          <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
          Rafraîchir
        </Button>
      </CardHeader>

      <CardContent className="space-y-4">
        {error ? <Alert variant="destructive">{error}</Alert> : null}

        {inventory?.runtimes
          .filter((report) => !report.ok)
          .map((report) => (
            <Alert key={report.runtime} variant="destructive">
              {report.runtime} n&apos;a rien pu dire : {report.error}
            </Alert>
          ))}

        {progress ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs">
              <Badge variant={progress.failed ? 'destructive' : 'secondary'}>
                {progress.done ? (progress.failed ? 'échec' : 'terminé') : 'en cours'}
              </Badge>
              <span className="text-muted-foreground font-mono">{progress.name}</span>
            </div>
            <pre className="bg-muted/40 max-h-48 overflow-auto rounded-md border p-2 font-mono text-[10px]">
              {progress.lines.length > 0 ? progress.lines.join('\n') : 'en attente du worker…'}
            </pre>
          </div>
        ) : null}

        {loading && items.length === 0 ? (
          <p className="text-muted-foreground text-sm">Interrogation de la machine…</p>
        ) : items.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {error ? 'Inventaire indisponible.' : 'Rien ne tourne sur cette machine.'}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Charge</TableHead>
                <TableHead>Origine</TableHead>
                <TableHead>Image</TableHead>
                <TableHead>État</TableHead>
                <TableHead>Ports</TableHead>
                <TableHead>Créée le</TableHead>
                {canManage ? <TableActionsHead>Actions</TableActionsHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((workload) => (
                <TableRow key={workload.ref}>
                  <TableCell>
                    <div className="font-mono text-xs">{workload.name}</div>
                    <div className="text-ink-faint text-[10px]">
                      {workload.kind}
                      {workload.scope ? ` · ${workload.scope}` : ''}
                    </div>
                  </TableCell>

                  <TableCell>
                    {workload.managed ? (
                      <Badge variant="secondary" className="gap-1">
                        <Lock className="size-3" aria-hidden="true" />
                        panel
                        {workload.managedApp ? ` · ${workload.managedApp}` : ''}
                      </Badge>
                    ) : (
                      <Badge variant="outline">hors panel</Badge>
                    )}
                  </TableCell>

                  <TableCell className="font-mono text-[11px]">{workload.image ?? '—'}</TableCell>

                  <TableCell>
                    <span className="inline-flex items-center gap-2">
                      <span
                        className={cn(
                          'inline-block size-2 shrink-0 rounded-full',
                          STATE_TONE[workload.state],
                        )}
                        aria-hidden="true"
                      />
                      <span className="text-xs">{STATE_LABEL[workload.state]}</span>
                    </span>
                    {workload.since ? (
                      <div className="text-ink-faint text-[10px]">{workload.since}</div>
                    ) : null}
                  </TableCell>

                  <TableCell className="font-mono text-[11px]">
                    {workload.ports.length > 0 ? workload.ports.join(', ') : '—'}
                  </TableCell>

                  <TableCell className="text-muted-foreground font-mono text-[11px]">
                    {formatDate(workload.createdAt)}
                  </TableCell>

                  {canManage ? (
                    <TableActions>
                      {workload.managed ? (
                        // Dire pourquoi le geste est absent vaut mieux que de
                        // laisser croire à un oubli.
                        <span className="text-ink-faint text-[11px]">
                          gérée par le panel — passez par son déploiement
                        </span>
                      ) : (
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy !== null}
                            onClick={() => void act(workload, 'update')}
                          >
                            <ArrowUpCircle className="size-3.5" />
                            Mettre à jour
                          </Button>
                          <Button
                            variant="destructive"
                            size="sm"
                            disabled={busy !== null}
                            onClick={() => void act(workload, 'remove')}
                          >
                            <Trash2 className="size-3.5" />
                            Supprimer
                          </Button>
                        </div>
                      )}
                    </TableActions>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
