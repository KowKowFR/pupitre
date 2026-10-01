'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Archive, Ellipsis, LoaderCircle, RotateCcw, Trash2 } from 'lucide-react';
import type { BackupMode, BackupPiece, BackupRetention } from '@pupitre/core';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CheckboxField } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented';
import { SwitchField } from '@/components/ui/switch';
import { IconButton } from '@/components/ui/tooltip';
import { useT } from '@/i18n/client';
import { backups as messages } from '@/i18n/messages/backups';
import { common } from '@/i18n/messages/common';
import { formatDateTime, type FormatSettings } from '@/lib/format';
import { relativeTime } from '@/lib/relative-time';
import { toast } from '@/lib/toast';

/**
 * Les sauvegardes d'une application : comment elle est sauvegardée, ce qu'une
 * sauvegarde contient, et ce qui a déjà été fait.
 *
 * La carte se lit elle-même (`GET /api/applications/:id/backups`) et se relit
 * tant qu'une sauvegarde est en cours : une sauvegarde dure des minutes, la
 * page n'a pas à être rechargée pour en connaître l'issue.
 */

type Policy = {
  enabled: boolean;
  mode: BackupMode;
  beforeDeploy: boolean;
  retention: BackupRetention;
  configured: boolean;
};

type BackupRow = {
  id: string;
  targetId: string | null;
  trigger: 'schedule' | 'manual' | 'pre_deploy' | 'pre_restore';
  mode: BackupMode | null;
  status: 'running' | 'success' | 'failed';
  bytes: number;
  pieces: Array<{ kind: string; label: string; bytes: number }>;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};

type Data = {
  policy: Policy;
  hasData: boolean;
  plan: Record<BackupMode, BackupPiece[]>;
  hotCopied: string[];
  destination: { description: string; lastCheckError: string | null } | null;
  schedule: { enabled: boolean; nextRunAt: string | null } | null;
  targets: Array<{ id: string; name: string; stopped: boolean }>;
  items: BackupRow[];
  lastRestore: { ok: boolean; at: string; actorName: string | null; error: string | null } | null;
};

type ApiError = { error?: { message?: string } };

const STATUS_VARIANT = { running: 'accent', success: 'ok', failed: 'danger' } as const;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  const units = ['Kio', 'Mio', 'Gio', 'Tio'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function ApplicationBackups({
  applicationId,
  applicationSlug,
  canManage,
  canRestore,
  canConfigure,
  format,
}: {
  applicationId: string;
  applicationSlug: string;
  canManage: boolean;
  canRestore: boolean;
  /** Peut régler la destination (`settings:manage`) : le lien vers les paramètres. */
  canConfigure: boolean;
  format: FormatSettings;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const [data, setData] = useState<Data | null>(null);
  const [draft, setDraft] = useState<Policy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<BackupRow | null>(null);
  const [safety, setSafety] = useState(true);
  const [deleting, setDeleting] = useState<BackupRow | null>(null);

  const load = useCallback(async () => {
    const response = await fetch(`/api/applications/${applicationId}/backups`, {
      cache: 'no-store',
    }).catch(() => null);
    if (!response?.ok) return null;
    return (await response.json()) as Data;
  }, [applicationId]);

  const refresh = useCallback(async () => {
    const next = await load();
    if (next) setData(next);
  }, [load]);

  // Premier chargement : l'état ne change que dans le rappel.
  useEffect(() => {
    let cancelled = false;
    void load().then((next) => {
      if (!cancelled && next) {
        setData(next);
        setDraft(next.policy);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  // Une sauvegarde en cours : on relit jusqu'à son issue.
  const running = data?.items.some((item) => item.status === 'running') ?? false;
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => void refresh(), 4000);
    return () => window.clearInterval(timer);
  }, [running, refresh]);

  async function call(url: string, init: RequestInit, done: string, detail?: string) {
    setError(null);
    const response = await fetch(url, {
      headers: { 'content-type': 'application/json' },
      ...init,
    }).catch(() => null);
    if (!response?.ok) {
      const body = response ? ((await response.json().catch(() => ({}))) as ApiError) : {};
      setError(body.error?.message ?? tc('http.failure', { status: response?.status ?? 0 }));
      return false;
    }
    toast({ title: done, ...(detail ? { description: detail } : {}), tone: 'ok' });
    await refresh();
    return true;
  }

  if (!data || !draft) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('card.title')}</CardTitle>
          <CardDescription>
            <LoaderCircle aria-hidden className="inline size-3.5 animate-spin" />
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  // `configured` n'est pas un réglage : il dit seulement si la ligne existe.
  const comparable = (policy: Policy) => JSON.stringify({ ...policy, configured: null });
  const dirty = comparable(draft) !== comparable(data.policy);
  const next = data.schedule?.nextRunAt ? formatDateTime(data.schedule.nextRunAt, format) : null;
  const liveTargets = data.targets;
  const pieceLabel = (piece: BackupPiece) =>
    piece.kind === 'dump'
      ? t('piece.dump', { engine: t(`engine.${piece.engine}`), service: piece.service })
      : t('piece.volume', { volume: piece.volume, service: piece.service });

  async function savePolicy() {
    if (!draft) return;
    setBusy('policy');
    const policy = {
      enabled: draft.enabled,
      mode: draft.mode,
      beforeDeploy: draft.beforeDeploy,
      retention: draft.retention,
    };
    await call(
      `/api/applications/${applicationId}/backup-policy`,
      { method: 'PUT', body: JSON.stringify(policy) },
      t('policy.saved'),
    );
    setBusy(null);
  }

  async function backupNow(targetId: string) {
    setBusy(`now:${targetId}`);
    await call(
      `/api/applications/${applicationId}/backups`,
      { method: 'POST', body: JSON.stringify({ targetId }) },
      t('now.queued'),
    );
    setBusy(null);
  }

  const targetName = (id: string | null) =>
    liveTargets.find((target) => target.id === id)?.name ?? '—';

  return (
    <Card>
      <CardHeader
        actions={
          canManage && data.hasData && data.destination && liveTargets.length > 0 ? (
            liveTargets.length === 1 ? (
              <Button
                variant="secondary"
                size="sm"
                loading={busy === `now:${liveTargets[0]?.id}`}
                disabled={running}
                onClick={() => liveTargets[0] && void backupNow(liveTargets[0].id)}
              >
                {busy ? null : <Archive aria-hidden />}
                {t('action.now')}
              </Button>
            ) : (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="secondary" size="sm" disabled={running}>
                    <Archive aria-hidden />
                    {t('action.now')}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {liveTargets.map((target) => (
                    <DropdownMenuItem key={target.id} onSelect={() => void backupNow(target.id)}>
                      {t('action.nowOn', { target: target.name })}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )
          ) : null
        }
      >
        <CardTitle>{t('card.title')}</CardTitle>
        <CardDescription>
          {!data.hasData
            ? t('card.noData')
            : data.policy.enabled
              ? next
                ? t('card.on', { next })
                : t('card.onNoSchedule')
              : t('card.off')}
          {data.destination
            ? ` ${t('card.destination', { destination: data.destination.description })}`
            : ''}
        </CardDescription>
      </CardHeader>

      {data.hasData ? (
        <CardContent className="flex flex-col gap-4">
          {error ? <Alert variant="destructive">{error}</Alert> : null}
          {!data.destination ? (
            <Alert variant="warn" title={t('card.noDestination')}>
              {canConfigure ? (
                <Link href="/admin/settings/sauvegardes" className="link">
                  {t('card.setDestination')}
                </Link>
              ) : null}
            </Alert>
          ) : null}
          {liveTargets.length === 0 ? (
            <p className="t-sm text-text-3">{t('card.notDeployed')}</p>
          ) : null}

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="flex flex-col gap-3">
              <SwitchField
                label={t('policy.enabled')}
                help={t('policy.enabled.help')}
                checked={draft.enabled}
                disabled={!canManage}
                onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
              />
              <SwitchField
                label={t('policy.beforeDeploy')}
                help={t('policy.beforeDeploy.help')}
                checked={draft.beforeDeploy}
                disabled={!canManage}
                onChange={(event) => setDraft({ ...draft, beforeDeploy: event.target.checked })}
              />
              <div className="flex flex-col gap-1.5">
                <span className="t-sm font-medium">{t('policy.mode')}</span>
                <SegmentedControl
                  label={t('policy.mode')}
                  value={draft.mode}
                  options={[
                    { value: 'hot', label: t('policy.mode.hot') },
                    { value: 'stop', label: t('policy.mode.stop') },
                  ]}
                  onChange={(mode) => canManage && setDraft({ ...draft, mode })}
                />
                <span className="help">
                  {draft.mode === 'hot' ? t('policy.mode.hot.help') : t('policy.mode.stop.help')}
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <span className="t-sm font-medium">{t('policy.contains')}</span>
                <ul className="flex flex-col gap-1">
                  {data.plan[draft.mode].map((piece) => (
                    <li
                      key={pieceLabel(piece)}
                      className="t-sm flex items-center gap-2 text-text-2"
                    >
                      <Badge variant={piece.kind === 'dump' ? 'accent' : 'idle'}>
                        {piece.kind === 'dump' ? 'export' : 'volume'}
                      </Badge>
                      {pieceLabel(piece)}
                    </li>
                  ))}
                </ul>
                {draft.mode === 'hot' && data.hotCopied.length > 0 ? (
                  <span className="help">
                    {t('policy.hotWarning', { services: data.hotCopied.join(', ') })}
                  </span>
                ) : null}
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="t-sm font-medium">{t('policy.retention')}</span>
                <div className="grid grid-cols-4 gap-2">
                  {(['keepLast', 'daily', 'weekly', 'monthly'] as const).map((field) => (
                    <label key={field} className="flex flex-col gap-1">
                      <span className="t-cap text-text-3">{t(`retention.${field}`)}</span>
                      <Input
                        type="number"
                        min={field === 'keepLast' ? 1 : 0}
                        max={field === 'daily' ? 365 : 120}
                        value={draft.retention[field]}
                        disabled={!canManage}
                        className="input-sm mono"
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            retention: {
                              ...draft.retention,
                              [field]: Math.max(
                                field === 'keepLast' ? 1 : 0,
                                Number(event.target.value) || 0,
                              ),
                            },
                          })
                        }
                      />
                    </label>
                  ))}
                </div>
                <span className="help">{t('policy.retention.help')}</span>
              </div>
            </div>
          </div>

          {canManage && dirty ? (
            <div className="flex justify-end">
              <Button size="sm" loading={busy === 'policy'} onClick={() => void savePolicy()}>
                {t('policy.save')}
              </Button>
            </div>
          ) : null}

          {data.lastRestore ? (
            <p className={data.lastRestore.ok ? 't-sm text-text-2' : 't-sm text-danger-text'}>
              {data.lastRestore.ok
                ? t('lastRestore.ok', {
                    date: formatDateTime(data.lastRestore.at, format),
                    who: data.lastRestore.actorName
                      ? t('lastRestore.who', { name: data.lastRestore.actorName })
                      : '',
                  })
                : t('lastRestore.failed', {
                    date: formatDateTime(data.lastRestore.at, format),
                    error: data.lastRestore.error ?? '—',
                  })}
            </p>
          ) : null}

          <div className="flex flex-col gap-2">
            <span className="t-sm font-medium">{t('history.title')}</span>
            {data.items.length === 0 ? (
              <p className="t-sm text-text-3">{t('history.empty')}</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border">
                {data.items.map((item) => (
                  <li
                    key={item.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
                  >
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="mono t-sm" title={item.startedAt}>
                          {formatDateTime(item.startedAt, format)}
                        </span>
                        <Badge variant={STATUS_VARIANT[item.status]} dot>
                          {item.status === 'running' ? (
                            <LoaderCircle aria-hidden className="size-3 animate-spin" />
                          ) : null}
                          {t(`status.${item.status}`)}
                        </Badge>
                        <span className="t-cap text-text-3">
                          {t(`trigger.${item.trigger}`)}
                          {item.mode ? ` · ${t(`mode.${item.mode}`)}` : ''}
                          {liveTargets.length > 1 ? ` · ${targetName(item.targetId)}` : ''}
                          {item.status === 'success' ? ` · ${formatBytes(item.bytes)}` : ''}
                          {item.finishedAt && item.status !== 'running'
                            ? ` · ${relativeTime(item.finishedAt, tc) ?? ''}`
                            : ''}
                        </span>
                      </span>
                      {item.status === 'failed' && item.error ? (
                        <span className="t-cap text-danger-text">{item.error}</span>
                      ) : item.pieces.length > 0 ? (
                        <span className="t-cap mono truncate text-text-3">
                          {item.pieces
                            .map((piece) => `${piece.label} (${formatBytes(piece.bytes)})`)
                            .join(' · ')}
                        </span>
                      ) : null}
                    </span>
                    {(canRestore && item.status === 'success') ||
                    (canManage && item.status !== 'running') ? (
                      <span className="flex items-center gap-1">
                        {canRestore && item.status === 'success' ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={running || liveTargets.length === 0}
                            onClick={() => {
                              setSafety(true);
                              setRestoring(item);
                            }}
                          >
                            <RotateCcw aria-hidden />
                            {t('action.restore')}
                          </Button>
                        ) : null}
                        {canManage ? (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <IconButton label={t('action.more')} size="icon-sm">
                                <Ellipsis />
                              </IconButton>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem destructive onSelect={() => setDeleting(item)}>
                                <Trash2 aria-hidden />
                                {t('action.delete')}…
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        ) : null}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CardContent>
      ) : null}

      <ConfirmDialog
        open={restoring !== null}
        onOpenChange={(open) => (open ? undefined : setRestoring(null))}
        level="data"
        title={
          restoring
            ? t('restore.title', {
                app: applicationSlug,
                date: formatDateTime(restoring.startedAt, format),
              })
            : ''
        }
        consequences={
          restoring
            ? [
                t('restore.replace', {
                  app: applicationSlug,
                  target: targetName(restoring.targetId),
                }),
                t('restore.downtime'),
                t('restore.code'),
              ]
            : []
        }
        retypeName={applicationSlug}
        confirmLabel={t('restore.confirm')}
        onConfirm={async () => {
          if (!restoring) return;
          const backup = restoring;
          setRestoring(null);
          await call(
            `/api/backups/${backup.id}/restore`,
            {
              method: 'POST',
              body: JSON.stringify({
                ...(backup.targetId ? { targetId: backup.targetId } : {}),
                safetyBackup: safety,
              }),
            },
            t('restore.queued'),
            t('restore.queued.detail'),
          );
        }}
      >
        <CheckboxField
          label={t('restore.safety')}
          help={t('restore.safety.help')}
          checked={safety}
          onChange={(event) => setSafety(event.target.checked)}
        />
      </ConfirmDialog>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => (open ? undefined : setDeleting(null))}
        level="reversible"
        title={
          deleting ? t('delete.title', { date: formatDateTime(deleting.startedAt, format) }) : ''
        }
        consequences={[t('delete.consequence')]}
        confirmLabel={t('action.delete')}
        onConfirm={async () => {
          if (!deleting) return;
          const backup = deleting;
          setDeleting(null);
          await call(`/api/backups/${backup.id}`, { method: 'DELETE' }, t('delete.queued'));
        }}
      />
    </Card>
  );
}
