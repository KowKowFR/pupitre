'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { Archive, CircleCheck, CircleHelp, CircleX, Trash2, Upload } from 'lucide-react';
import {
  SOURCE_ARCHIVES_KEPT,
  SOURCE_UPLOAD_MAX_BYTES,
  type DockerfileCheck,
  type SourceArchiveRejection,
} from '@pupitre/core';
import { formatBytes } from '@/components/backups/backup-history';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useT } from '@/i18n/client';
import { archives as messages } from '@/i18n/messages/archives';
import { common } from '@/i18n/messages/common';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

export type ArchiveView = {
  id: string;
  name: string;
  status: 'receiving' | 'pending' | 'ready' | 'rejected';
  uploadedBytes: number;
  sha256: string | null;
  files: number | null;
  unpackedBytes: number | null;
  strippedRoot: string | null;
  skippedEntries: number;
  rejection: { code: SourceArchiveRejection; detail: string | null } | null;
  uploadedByName: string | null;
  ago: string | null;
};

type ApiError = { error?: { message?: string } };

const STATUS_VARIANT = {
  receiving: 'idle',
  pending: 'accent',
  ready: 'ok',
  rejected: 'danger',
} as const;

const ACCEPT = '.tar.gz,.tgz,.tar,.zip,application/gzip,application/x-tar,application/zip';

/**
 * La carte « Code de l'application » : l'archive en service, ce que chaque
 * service construit y trouve, et les précédentes.
 *
 * L'envoi passe par `XMLHttpRequest` plutôt que `fetch` : c'est la seule API du
 * navigateur qui dise où en est un envoi, et une archive de 80 Mo mérite une
 * barre d'avancement. La lecture qui suit est l'affaire du worker ; la carte se
 * relit seule quand elle aboutit (`LiveRefresh` de la fiche).
 */
export function ApplicationArchive({
  applicationId,
  archives,
  checks,
  builds,
  canEdit,
}: {
  applicationId: string;
  archives: ArchiveView[];
  /** Pour l'archive en service, quand elle est prête. */
  checks: DockerfileCheck[];
  /** Un service au moins se construit depuis un Dockerfile. */
  builds: boolean;
  canEdit: boolean;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [upload, setUpload] = useState<{ name: string; percent: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [deleting, setDeleting] = useState<ArchiveView | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [current, ...previous] = archives.filter((archive) => archive.status !== 'receiving');

  function send(file: File) {
    setError(null);
    if (file.size > SOURCE_UPLOAD_MAX_BYTES) {
      setError(t('upload.tooLarge', { max: formatBytes(SOURCE_UPLOAD_MAX_BYTES) }));
      return;
    }
    setUpload({ name: file.name, percent: 0 });
    const request = new XMLHttpRequest();
    request.open('POST', `/api/applications/${applicationId}/archives`);
    // Un en-tête n'accepte que de l'ASCII : le nom voyage encodé.
    request.setRequestHeader('x-archive-name', encodeURIComponent(file.name));
    request.setRequestHeader('content-type', file.type || 'application/octet-stream');
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        setUpload({ name: file.name, percent: Math.round((event.loaded / event.total) * 100) });
      }
    };
    request.onload = () => {
      setUpload(null);
      if (request.status === 202) {
        toast({ title: t('upload.done'), tone: 'accent' });
        router.refresh();
        return;
      }
      let message = tc('http.failure', { status: request.status });
      try {
        message = (JSON.parse(request.responseText) as ApiError).error?.message ?? message;
      } catch {
        /* le statut suffit */
      }
      setError(t('upload.failed', { error: message }));
    };
    request.onerror = () => {
      setUpload(null);
      setError(t('upload.failed', { error: tc('http.failure', { status: 0 }) }));
    };
    request.send(file);
  }

  function choose(files: FileList | null) {
    const file = files?.[0];
    if (file) send(file);
    if (input.current) input.current.value = '';
  }

  async function remove(archive: ArchiveView) {
    setBusy(true);
    setDeleteError(null);
    const response = await fetch(`/api/applications/${applicationId}/archives/${archive.id}`, {
      method: 'DELETE',
    });
    setBusy(false);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      setDeleteError(
        t('delete.failed', {
          error: body.error?.message ?? tc('http.failure', { status: response.status }),
        }),
      );
      return;
    }
    setDeleting(null);
    toast({ title: t('delete.done'), tone: 'ok' });
    router.refresh();
  }

  const rejectionText = (archive: ArchiveView) => {
    if (!archive.rejection) return null;
    const { code, detail } = archive.rejection;
    const shown = code === 'too_large' && detail ? formatBytes(Number(detail)) : (detail ?? '');
    return t(`reject.${code}`, { detail: shown });
  };

  return (
    <Card>
      <CardHeader
        actions={
          canEdit ? (
            <Button
              variant="secondary"
              size="sm"
              loading={upload !== null}
              onClick={() => input.current?.click()}
            >
              <Upload aria-hidden />
              {t('upload.button')}
            </Button>
          ) : null
        }
      >
        <CardTitle>{t('card.title')}</CardTitle>
        <CardDescription>{t('card.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {canEdit ? (
          <input
            ref={input}
            type="file"
            accept={ACCEPT}
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(event) => choose(event.target.files)}
          />
        ) : null}
        {builds ? null : <Alert variant="info">{t('card.noBuild')}</Alert>}
        {error ? <Alert variant="destructive">{error}</Alert> : null}
        {upload ? (
          <div className="flex flex-col gap-1.5" role="status">
            <span className="t-sm text-text-2">
              {t('upload.progress', { name: upload.name, percent: upload.percent })}
            </span>
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
              <div
                className="h-full rounded-full bg-accent transition-[width]"
                style={{ width: `${upload.percent}%` }}
              />
            </div>
          </div>
        ) : null}

        {current ? (
          <section className="flex flex-col gap-3 rounded-[10px] border border-border p-4">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
              <Archive aria-hidden className="size-4 text-text-3" />
              <span className="t-cap text-text-3">{t('current.label')}</span>
              <span className="mono min-w-0 truncate font-medium">{current.name}</span>
              <Badge variant={STATUS_VARIANT[current.status]} dot>
                {t(`status.${current.status}`)}
              </Badge>
            </div>
            <ArchiveFacts archive={current} />
            {current.status === 'pending' ? (
              <p className="t-sm text-text-3">{t('meta.pending')}</p>
            ) : null}
            {current.status === 'rejected' ? (
              <Alert variant="destructive">{rejectionText(current)}</Alert>
            ) : null}
            {current.status === 'ready' && checks.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <span className="t-cap text-text-3">{t('checks.title')}</span>
                <ul className="flex flex-col gap-1">
                  {checks.map((check) => (
                    <li key={check.service} className="flex flex-wrap items-center gap-2 t-sm">
                      {check.status === 'found' ? (
                        <CircleCheck aria-hidden className="size-4 text-ok" />
                      ) : check.status === 'missing' ? (
                        <CircleX aria-hidden className="size-4 text-danger" />
                      ) : (
                        <CircleHelp aria-hidden className="size-4 text-text-3" />
                      )}
                      <span className="font-medium">{check.service}</span>
                      <span className="mono text-text-2">{check.path}</span>
                      <span
                        className={cn(
                          'text-text-3',
                          check.status === 'missing' && 'text-danger-text',
                        )}
                      >
                        {t(`check.${check.status}`)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>
        ) : canEdit ? (
          <button
            type="button"
            className={cn(
              'flex flex-col items-center gap-1.5 rounded-[10px] border border-dashed border-border px-4 py-6 text-center transition-colors',
              dragging ? 'border-accent bg-accent-soft' : 'hover:border-border-strong',
            )}
            onClick={() => input.current?.click()}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              choose(event.dataTransfer.files);
            }}
          >
            <Upload aria-hidden className="size-5 text-text-3" />
            <span className="t-sm font-medium text-text">{t('upload.drop')}</span>
            <span className="t-cap text-text-3">
              {t('upload.hint', { max: formatBytes(SOURCE_UPLOAD_MAX_BYTES) })}
            </span>
          </button>
        ) : (
          <p className="t-sm text-text-3">{t('card.empty')}</p>
        )}

        {current && canEdit ? (
          <p className="t-cap text-text-3">
            {t('upload.hint', { max: formatBytes(SOURCE_UPLOAD_MAX_BYTES) })}
          </p>
        ) : null}

        {previous.length > 0 ? (
          <div className="flex flex-col gap-2">
            <span className="t-cap text-text-3">{t('history.title')}</span>
            <ul className="list">
              {previous.map((archive) => (
                <li key={archive.id} className="flex flex-wrap items-center gap-2">
                  <span className="mono min-w-0 truncate t-sm">{archive.name}</span>
                  <Badge variant={STATUS_VARIANT[archive.status]}>
                    {t(`status.${archive.status}`)}
                  </Badge>
                  <span className="t-cap text-text-3">
                    {formatBytes(archive.uploadedBytes)}
                    {archive.ago ? ` · ${archive.ago}` : ''}
                  </span>
                  {archive.status === 'rejected' ? (
                    <span className="t-cap text-danger-text">{rejectionText(archive)}</span>
                  ) : null}
                  {canEdit ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto"
                      aria-label={t('delete.label', { name: archive.name })}
                      onClick={() => {
                        setDeleteError(null);
                        setDeleting(archive);
                      }}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
            <p className="t-cap text-text-3">
              {t('history.kept', { count: SOURCE_ARCHIVES_KEPT })}
            </p>
          </div>
        ) : null}
      </CardContent>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => (open ? undefined : setDeleting(null))}
        level="trace"
        title={t('delete.title', { name: deleting?.name ?? '' })}
        consequences={[t('delete.body')]}
        confirmLabel={t('delete.confirm')}
        pending={busy}
        error={deleteError}
        onConfirm={() => (deleting ? remove(deleting) : undefined)}
      />
    </Card>
  );
}

function ArchiveFacts({ archive }: { archive: ArchiveView }) {
  const t = useT(messages);
  const facts = [
    formatBytes(archive.uploadedBytes),
    archive.files !== null ? t('meta.files', { count: archive.files }) : null,
    archive.unpackedBytes !== null
      ? t('meta.unpacked', { size: formatBytes(archive.unpackedBytes) })
      : null,
    archive.ago
      ? archive.uploadedByName
        ? t('meta.by', { name: archive.uploadedByName, ago: archive.ago })
        : t('meta.anonymous', { ago: archive.ago })
      : null,
  ].filter(Boolean);
  return (
    <div className="flex flex-col gap-1">
      <p className="t-sm text-text-2">{facts.join(' · ')}</p>
      {archive.strippedRoot || archive.skippedEntries > 0 ? (
        <p className="t-cap text-text-3">
          {[
            archive.strippedRoot ? t('meta.stripped', { root: archive.strippedRoot }) : null,
            archive.skippedEntries > 0
              ? t('meta.skipped', { count: archive.skippedEntries })
              : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      ) : null}
      {archive.sha256 ? (
        <p className="t-cap text-text-3">
          {t('meta.sha')}{' '}
          <span className="mono" title={archive.sha256}>
            {archive.sha256.slice(0, 16)}…
          </span>
        </p>
      ) : null}
    </div>
  );
}
