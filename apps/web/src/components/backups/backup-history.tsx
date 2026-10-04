'use client';

import { useState } from 'react';
import { Ellipsis, LoaderCircle, RotateCcw, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CheckboxField } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import { IconButton } from '@/components/ui/tooltip';
import { useT } from '@/i18n/client';
import { backups as messages } from '@/i18n/messages/backups';
import { common } from '@/i18n/messages/common';
import type { BackupView, LiveTargetView } from '@/lib/backups';
import { formatDateTime, type FormatSettings } from '@/lib/format';
import { relativeTime } from '@/lib/relative-time';

/**
 * An application's backups history, with what can be done with it: restore,
 * delete. Shared by the record's card and by the settings' overview — the same
 * gesture must not have two screens that diverge.
 *
 * The component does not talk to the API itself: it receives `run`, which calls,
 * reports the outcome and reads the screen again in its host's way.
 */

export type BackupHistoryItem = Pick<
  BackupView,
  | 'id'
  | 'targetId'
  | 'trigger'
  | 'mode'
  | 'status'
  | 'bytes'
  | 'pieces'
  | 'error'
  | 'startedAt'
  | 'finishedAt'
>;

export type BackupRun = (
  url: string,
  init: RequestInit,
  done: string,
  detail?: string,
) => Promise<boolean>;

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

export function BackupHistory({
  applicationSlug,
  restorable,
  items,
  targets,
  targetNames,
  canRestore,
  canManage,
  busy,
  format,
  run,
}: {
  applicationSlug: string;
  /** `false` for a deleted application: nothing left to restore into. */
  restorable: boolean;
  items: BackupHistoryItem[];
  /** The targets where the application runs: where a restore can go. */
  targets: LiveTargetView[];
  /** The name of each target the history mentions, whether it still carries the application. */
  targetNames: Record<string, string>;
  canRestore: boolean;
  canManage: boolean;
  /** A backup or a restore is in progress: another one is not started. */
  busy: boolean;
  format: FormatSettings;
  run: BackupRun;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const [restoring, setRestoring] = useState<BackupHistoryItem | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<string | null>(null);
  const [safety, setSafety] = useState(true);
  const [deleting, setDeleting] = useState<BackupHistoryItem | null>(null);

  // A stopped application is not restored: the route would refuse it.
  const eligible = targets.filter((target) => !target.stopped);
  const nameOf = (id: string | null) =>
    (id ? (targetNames[id] ?? targets.find((target) => target.id === id)?.name) : null) ?? '—';
  const showTarget = targets.length > 1 || new Set(items.map((item) => item.targetId)).size > 1;

  function openRestore(item: BackupHistoryItem) {
    // By default, the target the backup comes from — if it still carries the application.
    const origin = eligible.find((target) => target.id === item.targetId);
    setRestoreTarget(origin?.id ?? eligible[0]?.id ?? null);
    setSafety(true);
    setRestoring(item);
  }

  if (items.length === 0) return <p className="t-sm text-text-3">{t('history.empty')}</p>;

  return (
    <>
      <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border">
        {items.map((item) => (
          <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
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
                {/* "14 s ago": the server and the browser do not read the clock at the same
                    second. */}
                <span className="t-cap text-text-3" suppressHydrationWarning>
                  {t(`trigger.${item.trigger}`)}
                  {item.mode ? ` · ${t(`mode.${item.mode}`)}` : ''}
                  {showTarget ? ` · ${nameOf(item.targetId)}` : ''}
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
            {(restorable && canRestore && item.status === 'success') ||
            (canManage && item.status !== 'running') ? (
              <span className="flex items-center gap-1">
                {restorable && canRestore && item.status === 'success' ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy || eligible.length === 0}
                    onClick={() => openRestore(item)}
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
                t('restore.replace', { app: applicationSlug, target: nameOf(restoreTarget) }),
                t('restore.downtime'),
                t('restore.code'),
              ]
            : []
        }
        retypeName={applicationSlug}
        confirmLabel={t('restore.confirm')}
        onConfirm={async () => {
          if (!restoring || !restoreTarget) return;
          const backup = restoring;
          setRestoring(null);
          await run(
            `/api/backups/${backup.id}/restore`,
            {
              method: 'POST',
              body: JSON.stringify({ targetId: restoreTarget, safetyBackup: safety }),
            },
            t('restore.queued'),
            t('restore.queued.detail'),
          );
        }}
      >
        <div className="flex flex-col gap-3">
          {eligible.length > 1 ? (
            <Field
              label={t('restore.target')}
              help={
                restoring && restoreTarget !== restoring.targetId
                  ? t('restore.target.other', { origin: nameOf(restoring.targetId) })
                  : undefined
              }
            >
              <Select
                value={restoreTarget ?? ''}
                onChange={(event) => setRestoreTarget(event.target.value)}
              >
                {eligible.map((target) => (
                  <option key={target.id} value={target.id}>
                    {target.name}
                    {restoring && target.id === restoring.targetId
                      ? ` — ${t('restore.target.origin')}`
                      : ''}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <CheckboxField
            label={t('restore.safety')}
            help={t('restore.safety.help')}
            checked={safety}
            onChange={(event) => setSafety(event.target.checked)}
          />
        </div>
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
          await run(`/api/backups/${backup.id}`, { method: 'DELETE' }, t('delete.queued'));
        }}
      />
    </>
  );
}
