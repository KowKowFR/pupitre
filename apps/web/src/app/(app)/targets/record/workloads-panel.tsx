'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowUpCircle,
  Ellipsis,
  Play,
  RefreshCw,
  RotateCw,
  ScrollText,
  Square,
  SquareTerminal,
  Trash2,
} from 'lucide-react';
import type { ServiceState, Translate, Workload, WorkloadControlAction } from '@pupitre/core';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { State, type Tone } from '@/components/ui/led';
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
import { IconButton } from '@/components/ui/tooltip';
import { useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { targets as messages } from '@/i18n/messages/targets';
import { WorkloadRunDrawer, type RunMode } from './workload-run-drawer';

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

/** Ce qui demande une confirmation. Démarrer n'en demande pas : rien ne s'interrompt. */
type ConfirmedAction = 'remove' | 'update' | 'stop' | 'restart';
type Action = ConfirmedAction | 'start';

const CONTROL_ICON: Record<WorkloadControlAction, typeof Play> = {
  start: Play,
  stop: Square,
  restart: RotateCw,
};

/**
 * L'adresse de chaque geste. Supprimer est le `DELETE` de la charge ; les
 * autres sont des sous-ressources, et ceux du cycle de vie partagent la leur.
 */
function request(
  targetId: string,
  ref: string,
  action: Action,
): { url: string; init: RequestInit } {
  const base = `/api/targets/${targetId}/workloads/${encodeURIComponent(ref)}`;
  if (action === 'remove') return { url: base, init: { method: 'DELETE' } };
  if (action === 'update') return { url: `${base}/update`, init: { method: 'POST' } };
  return {
    url: `${base}/control`,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    },
  };
}

const STATE_TONE: Record<ServiceState, Tone> = {
  running: 'ok',
  restarting: 'warn',
  exited: 'idle',
  paused: 'warn',
  created: 'accent',
  unknown: 'idle',
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

export function WorkloadsPanel({
  targetId,
  canManage,
  canExec,
}: {
  targetId: string;
  canManage: boolean;
  canExec: boolean;
}) {
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

  /** Le geste en attente de confirmation, s'il y en a un. */
  const [pending, setPending] = useState<{ workload: WorkloadRow; action: ConfirmedAction } | null>(
    null,
  );
  /** Le journal ou la console ouverts, s'il y en a. */
  const [session, setSession] = useState<{ workload: WorkloadRow; mode: RunMode } | null>(null);

  async function act(workload: WorkloadRow, action: Action) {
    setPending(null);
    setBusy(workload.ref);
    setError(null);
    await openStream(workload.ref, workload.name);

    const { url, init } = request(targetId, workload.ref, action);
    const response = await fetch(url, init);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      setError(body.error?.message ?? tc('http.failure', { status: response.status }));
      setBusy(null);
      setProgress(null);
      closeStream();
    }
  }

  const items = inventory?.items ?? [];
  // `kind` vient du driver — `container`, `pod`, `deployment` : c'est le
  // runtime qui nomme la chose. Il entre dans la phrase avec le mot de la
  // langue courante, jamais avec la clé.
  const confirmVars = pending
    ? {
        kind: kindLabel(pending.workload.kind, t),
        name: pending.workload.name,
        image: pending.workload.image ?? t('image.unknown'),
      }
    : null;

  return (
    <section className="card overflow-hidden">
      <div className="card-h">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2>{t('workloads.title')}</h2>
          {/* Trois fragments : deux décomptes qui s'accordent chacun de leur
              côté, et la date du relevé. */}
          <span className="sub">
            {inventory
              ? `${t('workloads.count', { count: inventory.total })}, ${t('workloads.managed', {
                  count: inventory.managed,
                })} · ${t('workloads.readout', {
                  date: formatDate(inventory.checkedAt, tc('none')),
                })}`
              : t('workloads.subtitle')}
          </span>
        </div>
        <Button variant="secondary" size="sm" onClick={() => void reload()} loading={loading}>
          {loading ? null : <RefreshCw aria-hidden />}
          {tc('refresh')}
        </Button>
      </div>

      {error || progress || inventory?.runtimes.some((report) => !report.ok) ? (
        <div className="card-b flex flex-col gap-3 border-b border-border-subtle">
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
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <Badge variant={progress.failed ? 'danger' : progress.done ? 'ok' : 'accent'} dot>
                  {progress.done
                    ? progress.failed
                      ? t('progress.failed')
                      : t('progress.done')
                    : t('progress.running')}
                </Badge>
                <span className="mono text-[12px] text-text-2">{progress.name}</span>
              </div>
              <div className="term max-h-48">
                <div className="term-b">
                  {(progress.lines.length > 0 ? progress.lines : [t('progress.waiting')]).map(
                    (line, index) => (
                      <div key={index} className="ln">
                        {line}
                      </div>
                    ),
                  )}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {loading && items.length === 0 ? (
        <p className="t-sm px-4 py-5 text-text-3">{t('workloads.loading')}</p>
      ) : items.length === 0 ? (
        <p className="t-sm px-4 py-5 text-text-3">
          {error ? t('workloads.unavailable') : t('workloads.empty')}
        </p>
      ) : (
        <Table label={t('workloads.title')}>
          <TableHeader>
            <TableRow>
              <TableHead>{t('column.workload')}</TableHead>
              <TableHead>{t('column.origin')}</TableHead>
              <TableHead>{t('column.image')}</TableHead>
              <TableHead>{tc('column.state')}</TableHead>
              <TableHead>{t('column.ports')}</TableHead>
              <TableHead>{t('column.createdAt')}</TableHead>
              {canManage || canExec ? (
                <TableActionsHead>{tc('column.actions')}</TableActionsHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((workload) => (
              <TableRow key={workload.ref}>
                <TableCell>
                  <span className="flex flex-col">
                    <span className="mono text-[12.5px] font-semibold">{workload.name}</span>
                    <span className="t-cap text-text-3">
                      {kindLabel(workload.kind, t)}
                      {workload.scope ? ` · ${workload.scope}` : ''}
                    </span>
                  </span>
                </TableCell>
                <TableCell>
                  {workload.managed ? (
                    <Badge variant="accent">
                      {t('origin.panel')}
                      {workload.managedApp ? ` · ${workload.managedApp}` : ''}
                    </Badge>
                  ) : (
                    <Badge variant="outline">{t('origin.outside')}</Badge>
                  )}
                </TableCell>
                <TableCell>
                  <span className="mono inline-block max-w-[240px] truncate text-[12px] text-text-2">
                    {workload.image ?? tc('none')}
                  </span>
                </TableCell>
                <TableCell>
                  <State tone={STATE_TONE[workload.state]} pulse={workload.state === 'created'}>
                    {t(`state.${workload.state}`)}
                  </State>
                  {workload.since ? <div className="t-cap text-text-3">{workload.since}</div> : null}
                </TableCell>
                <TableCell className="mono text-text-2">
                  {workload.ports.length > 0 ? workload.ports.join(', ') : tc('none')}
                </TableCell>
                <TableCell className="mono text-text-3">
                  {formatDate(workload.createdAt, tc('none'))}
                </TableCell>
                {canManage || canExec ? (
                  <TableActions>
                    <WorkloadMenu
                      workload={workload}
                      canManage={canManage}
                      canExec={canExec}
                      disabled={busy !== null}
                      onAction={(action) =>
                        action === 'start'
                          ? void act(workload, action)
                          : setPending({ workload, action })
                      }
                      onSession={(mode) => setSession({ workload, mode })}
                    />
                  </TableActions>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => (open ? undefined : setPending(null))}
        level={pending?.action === 'remove' ? 'data' : 'reversible'}
        title={confirmVars && pending ? t(`workload.${pending.action}.title`, confirmVars) : ''}
        consequences={!confirmVars || !pending ? [] : CONSEQUENCES[pending.action](t, confirmVars)}
        retypeName={pending?.action === 'remove' ? pending.workload.name : undefined}
        confirmLabel={
          pending?.action === 'remove' ? tc('delete') : pending ? t(`action.${pending.action}`) : ''
        }
        onConfirm={() => (pending ? act(pending.workload, pending.action) : undefined)}
      />

      {session ? (
        <WorkloadRunDrawer
          key={`${session.workload.ref}:${session.mode}`}
          targetId={targetId}
          workload={session.workload}
          mode={session.mode}
          onClose={() => setSession(null)}
        />
      ) : null}
    </section>
  );
}

type ConfirmVars = { kind: string; name: string; image: string };

/** Ce que chaque geste confirmé va faire, dit avant qu'il ne le fasse. */
const CONSEQUENCES: Record<ConfirmedAction, (t: Messages, vars: ConfirmVars) => string[]> = {
  remove: (t, vars) => [
    t('workload.remove.image', vars),
    t('workload.remove.final'),
    t('workload.remove.volumes'),
  ],
  update: (t, vars) => [
    t('workload.update.pull', vars),
    t('workload.update.recreate'),
    t('workload.update.downtime'),
  ],
  stop: (t) => [t('workload.stop.signal'), t('workload.stop.unreachable'), t('workload.stop.keep')],
  restart: (t) => [t('workload.restart.same'), t('workload.update.downtime')],
};

/**
 * Le menu d'une ligne. Il n'offre que ce que le driver a dit possible pour
 * cette charge, dans son état (`controls`, `exec`) — l'écran ne devine rien du
 * runtime. Une charge du panel ne se supprime ni ne se met à jour d'ici.
 */
function WorkloadMenu({
  workload,
  canManage,
  canExec,
  disabled,
  onAction,
  onSession,
}: {
  workload: WorkloadRow;
  canManage: boolean;
  canExec: boolean;
  disabled: boolean;
  onAction: (action: Action) => void;
  onSession: (mode: RunMode) => void;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const controls = canManage ? workload.controls : [];
  const editable = canManage && !workload.managed;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton
          label={t('action.more', { name: workload.name })}
          size="icon-sm"
          disabled={disabled}
        >
          <Ellipsis />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        {workload.managed ? (
          <DropdownMenuLabel className="t-cap font-normal text-text-3">
            {workload.managedApp
              ? t('workload.menu.managedApp', { app: workload.managedApp })
              : t('workload.menu.managed')}
          </DropdownMenuLabel>
        ) : null}
        {canManage ? (
          <DropdownMenuItem onSelect={() => onSession('logs')}>
            <ScrollText aria-hidden />
            {t('action.logs')}
          </DropdownMenuItem>
        ) : null}
        {canExec ? (
          <DropdownMenuItem disabled={!workload.exec} onSelect={() => onSession('exec')}>
            <SquareTerminal aria-hidden />
            {t('action.exec')}
          </DropdownMenuItem>
        ) : null}
        {controls.length > 0 ? <DropdownMenuSeparator /> : null}
        {controls.map((action) => {
          const Icon = CONTROL_ICON[action];
          return (
            <DropdownMenuItem key={action} onSelect={() => onAction(action)}>
              <Icon aria-hidden />
              {t(`action.${action}`)}
              {action === 'start' ? null : '…'}
            </DropdownMenuItem>
          );
        })}
        {editable ? (
          <>
            <DropdownMenuItem onSelect={() => onAction('update')}>
              <ArrowUpCircle aria-hidden />
              {t('action.update')}…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive onSelect={() => onAction('remove')}>
              <Trash2 aria-hidden />
              {tc('delete')}…
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
