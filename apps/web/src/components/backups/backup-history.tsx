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
 * L'historique des sauvegardes d'une application, avec ce qu'on peut en faire :
 * restaurer, supprimer. Partagé par la carte de la fiche et par la vue
 * d'ensemble des paramètres — le même geste ne doit pas avoir deux écrans qui
 * divergent.
 *
 * Le composant ne parle pas lui-même à l'API : il reçoit `run`, qui appelle,
 * signale l'issue et relit l'écran à la manière de son hôte.
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
  /** `false` pour une application supprimée : plus rien où restaurer. */
  restorable: boolean;
  items: BackupHistoryItem[];
  /** Les cibles où l'application tourne : là où une restauration peut aller. */
  targets: LiveTargetView[];
  /** Le nom de chaque cible citée par l'historique, qu'elle porte encore l'application ou non. */
  targetNames: Record<string, string>;
  canRestore: boolean;
  canManage: boolean;
  /** Une sauvegarde ou une restauration est en cours : on n'en lance pas une autre. */
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

  // Une application arrêtée ne se restaure pas : la route le refuserait.
  const eligible = targets.filter((target) => !target.stopped);
  const nameOf = (id: string | null) =>
    (id ? (targetNames[id] ?? targets.find((target) => target.id === id)?.name) : null) ?? '—';
  const showTarget = targets.length > 1 || new Set(items.map((item) => item.targetId)).size > 1;

  function openRestore(item: BackupHistoryItem) {
    // Par défaut, la cible d'où vient la sauvegarde — si elle porte encore l'application.
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
                {/* « il y a 14 s » : le serveur et le navigateur ne lisent pas l'horloge à la même seconde. */}
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
