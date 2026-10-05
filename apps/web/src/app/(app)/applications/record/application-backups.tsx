'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Archive, LoaderCircle } from 'lucide-react';
import type { BackupMode, BackupPiece, BackupRetention } from '@pupitre/core';
import { Alert } from '@/components/ui/alert';
import { BackupHistory, type BackupHistoryItem } from '@/components/backups/backup-history';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented';
import { SwitchField } from '@/components/ui/switch';
import { useT } from '@/i18n/client';
import { backups as messages } from '@/i18n/messages/backups';
import { common } from '@/i18n/messages/common';
import type { LastRestoreView, LiveTargetView } from '@/lib/backups';
import { formatDateTime, type FormatSettings } from '@/lib/format';
import { toast } from '@/lib/toast';

/**
 * An application's backups: how it is backed up, what a backup contains, and
 * what has already been done.
 *
 * The card reads itself (`GET /api/applications/:id/backups`) and reads itself
 * again while a backup is in progress: a backup lasts minutes, the page does not
 * have to be reloaded to know how it ended.
 */

type Policy = {
  enabled: boolean;
  mode: BackupMode;
  beforeDeploy: boolean;
  retention: BackupRetention;
  configured: boolean;
};

type Data = {
  policy: Policy;
  hasData: boolean;
  plan: Record<BackupMode, BackupPiece[]>;
  hotCopied: string[];
  destination: { description: string; lastCheckError: string | null } | null;
  schedule: { enabled: boolean; nextRunAt: string | null } | null;
  targets: LiveTargetView[];
  targetNames: Record<string, string>;
  items: BackupHistoryItem[];
  lastRestore: LastRestoreView | null;
};

type ApiError = { error?: { message?: string } };

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
  /** Can set the destination (`settings:manage`): the link to the settings. */
  canConfigure: boolean;
  format: FormatSettings;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const [data, setData] = useState<Data | null>(null);
  const [draft, setDraft] = useState<Policy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

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

  // First load: the state only changes in the callback.
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

  // A backup in progress: we read again until it ends.
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

  // `configured` is not a setting: it only says whether the row exists.
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
                <Link href="/admin/settings/backups" className="link">
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
            <BackupHistory
              applicationSlug={applicationSlug}
              restorable
              items={data.items}
              targets={liveTargets}
              targetNames={data.targetNames}
              canRestore={canRestore}
              canManage={canManage}
              busy={running}
              format={format}
              run={call}
            />
          </div>
        </CardContent>
      ) : null}
    </Card>
  );
}
