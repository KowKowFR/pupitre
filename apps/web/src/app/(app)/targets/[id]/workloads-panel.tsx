'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw, Trash2, ArrowUpCircle, Lock } from 'lucide-react';
import type { ServiceState, Translate, Workload } from '@pupitre/core';
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
import { useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { targets as messages } from '@/i18n/messages/targets';
import { cn } from '@/lib/utils';

/**
 * Ce qui tourne sur la cible, panel compris.
 *
 * Le mot « charge » ne s'affiche nulle part : chaque ligne se nomme comme son
 * runtime la nomme — « conteneur », « deployment », « pod » — parce que c'est le
 * driver qui a rempli le champ `kind`. L'interface parle donc la langue de la
 * machine sans que le code n'ait à deviner de quel runtime il s'agit.
 *
 * Le driver pose une **clé** (`container`, `pod`, `deployment`, …), pas un mot :
 * c'est ici, et nulle part ailleurs, qu'elle devient une phrase — sans quoi un
 * panel anglais demanderait « Remove conteneur "x"? ». Un genre venu d'un
 * runtime que ce dictionnaire ne connaît pas s'affiche tel quel.
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

const STATE_TONE: Record<ServiceState, string> = {
  running: 'bg-ok',
  restarting: 'bg-warn',
  exited: 'bg-text-3',
  paused: 'bg-warn',
  created: 'bg-warn',
  unknown: 'bg-text-3',
};

/**
 * Les genres de charge que ce panel sait nommer. Une clé absente d'ici n'est
 * pas une erreur : c'est un runtime plus récent que ce dictionnaire, et son mot
 * brut vaut mieux qu'une clé affichée à l'écran.
 */
const KNOWN_KINDS = ['container', 'pod', 'deployment', 'statefulset', 'daemonset'] as const;
type KnownKind = (typeof KNOWN_KINDS)[number];

function isKnownKind(kind: string): kind is KnownKind {
  return (KNOWN_KINDS as readonly string[]).includes(kind);
}

type Messages = Translate<(typeof messages)['fr']>;

function kindLabel(kind: string, t: Messages): string {
  return isKnownKind(kind) ? t(`workload.kind.${kind}`) : kind;
}

function formatDate(iso: string | null, none: string): string {
  if (!iso) return none;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? none : date.toISOString().slice(0, 16).replace('T', ' ');
}

export function WorkloadsPanel({ targetId, canManage }: { targetId: string; canManage: boolean }) {
  const router = useRouter();
  const t = useT(messages);
  const tc = useT(common);
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
      throw new Error(
        body.error?.message ?? t('workloads.error.http', { status: response.status }),
      );
    }
    return (await response.json()) as Inventory;
  }, [targetId, t]);

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
      apply(cause instanceof Error ? cause : new Error(t('workloads.error.plain')));
    }
  }, [apply, fetchInventory, t]);

  // Premier chargement : les mises à jour d'état n'ont lieu que dans les
  // rappels de la promesse, jamais dans le corps de l'effet.
  useEffect(() => {
    let cancelled = false;
    fetchInventory().then(
      (result) => {
        if (!cancelled) apply(result);
      },
      (cause: unknown) => {
        if (!cancelled) {
          apply(cause instanceof Error ? cause : new Error(t('workloads.error.plain')));
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [apply, fetchInventory, t]);

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
                  lines:
                    failed && payload.detail ? [...current.lines, payload.detail] : current.lines,
                }
              : current,
          );
          if (failed) setError(payload.detail ?? t('workloads.error.silent'));
          closeStream();
          setBusy(null);
          void reload();
          router.refresh();
        });
        stream.onerror = () => resolve();
      }),
    [closeStream, reload, router, t, targetId],
  );

  async function act(workload: WorkloadRow, action: 'remove' | 'update') {
    // `kind` vient du driver — `container`, `pod`, `deployment` : c'est le
    // runtime qui nomme la chose, pas le panel. Il entre dans la phrase avec le
    // mot de la langue courante, jamais avec la clé.
    const vars = {
      kind: kindLabel(workload.kind, t),
      name: workload.name,
      image: workload.image ?? t('image.unknown'),
    };
    const question = t(action === 'remove' ? 'confirm.remove' : 'confirm.update', vars);

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
      setError(body.error?.message ?? tc('http.failure', { status: response.status }));
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
          <CardTitle>{t('workloads.title')}</CardTitle>
          {/* Trois fragments : deux décomptes qui s'accordent chacun de leur
              côté, et la date du relevé. */}
          <CardDescription>
            {inventory
              ? `${t('workloads.count', { count: inventory.total })}, ${t('workloads.managed', {
                  count: inventory.managed,
                })} · ${t('workloads.readout', {
                  date: formatDate(inventory.checkedAt, tc('none')),
                })}`
              : t('workloads.subtitle')}
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => void reload()} disabled={loading}>
          <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
          {tc('refresh')}
        </Button>
      </CardHeader>

      <CardContent className="space-y-4">
        {error ? <Alert variant="destructive">{error}</Alert> : null}

        {inventory?.runtimes
          .filter((report) => !report.ok)
          .map((report) => (
            <Alert key={report.runtime} variant="destructive">
              {t('workloads.runtimeError', {
                runtime: report.runtime,
                error: report.error ?? '',
              })}
            </Alert>
          ))}

        {progress ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs">
              <Badge variant={progress.failed ? 'destructive' : 'secondary'}>
                {progress.done
                  ? progress.failed
                    ? t('progress.failed')
                    : t('progress.done')
                  : t('progress.running')}
              </Badge>
              <span className="text-muted-foreground font-mono">{progress.name}</span>
            </div>
            <pre className="bg-muted/40 max-h-48 overflow-auto rounded-md border p-2 font-mono text-[10px]">
              {progress.lines.length > 0 ? progress.lines.join('\n') : t('progress.waiting')}
            </pre>
          </div>
        ) : null}

        {loading && items.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('workloads.loading')}</p>
        ) : items.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {error ? t('workloads.unavailable') : t('workloads.empty')}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('column.workload')}</TableHead>
                <TableHead>{t('column.origin')}</TableHead>
                <TableHead>{t('column.image')}</TableHead>
                <TableHead>{tc('column.state')}</TableHead>
                <TableHead>{t('column.ports')}</TableHead>
                <TableHead>{t('column.createdAt')}</TableHead>
                {canManage ? <TableActionsHead>{tc('column.actions')}</TableActionsHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((workload) => (
                <TableRow key={workload.ref}>
                  <TableCell>
                    <div className="font-mono text-xs">{workload.name}</div>
                    <div className="text-text-3 text-[10px]">
                      {kindLabel(workload.kind, t)}
                      {workload.scope ? ` · ${workload.scope}` : ''}
                    </div>
                  </TableCell>

                  <TableCell>
                    {workload.managed ? (
                      <Badge variant="secondary" className="gap-1">
                        <Lock className="size-3" aria-hidden="true" />
                        {t('origin.panel')}
                        {workload.managedApp ? ` · ${workload.managedApp}` : ''}
                      </Badge>
                    ) : (
                      <Badge variant="outline">{t('origin.outside')}</Badge>
                    )}
                  </TableCell>

                  <TableCell className="font-mono text-[11px]">
                    {workload.image ?? tc('none')}
                  </TableCell>

                  <TableCell>
                    <span className="inline-flex items-center gap-2">
                      <span
                        className={cn(
                          'inline-block size-2 shrink-0 rounded-full',
                          STATE_TONE[workload.state],
                        )}
                        aria-hidden="true"
                      />
                      <span className="text-xs">{t(`state.${workload.state}`)}</span>
                    </span>
                    {workload.since ? (
                      <div className="text-text-3 text-[10px]">{workload.since}</div>
                    ) : null}
                  </TableCell>

                  <TableCell className="font-mono text-[11px]">
                    {workload.ports.length > 0 ? workload.ports.join(', ') : tc('none')}
                  </TableCell>

                  <TableCell className="text-muted-foreground font-mono text-[11px]">
                    {formatDate(workload.createdAt, tc('none'))}
                  </TableCell>

                  {canManage ? (
                    <TableActions>
                      {workload.managed ? (
                        // Dire pourquoi le geste est absent vaut mieux que de
                        // laisser croire à un oubli.
                        <span className="text-text-3 text-[11px]">
                          {t('workloads.managedNotice')}
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
                            {t('action.update')}
                          </Button>
                          <Button
                            variant="destructive"
                            size="sm"
                            disabled={busy !== null}
                            onClick={() => void act(workload, 'remove')}
                          >
                            <Trash2 className="size-3.5" />
                            {tc('delete')}
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
