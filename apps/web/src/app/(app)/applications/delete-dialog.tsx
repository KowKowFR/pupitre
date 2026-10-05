'use client';

import { useCallback, useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { applications as messages } from '@/i18n/messages/applications';
import { chrome } from '@/i18n/messages/chrome';
import { confirmMatches } from '@/lib/confirm';
import { withSlot } from '@/lib/rich';

/**
 * Confirming an application's deletion.
 *
 * Three screens in a single modal, because they are three moments of the same
 * gesture and the user is not sent elsewhere in between:
 *
 *   1. **Nothing blocks** — the application only carries history. We say how many
 *      rows go and which ports are released, and we erase.
 *   2. **Something runs** — we name each deployment still in place: the target,
 *      the Compose project, the port. The cascade will destroy them.
 *   3. **A target resisted** — we name what will remain on the machine, and
 *      forcing unlocks by typing the application's name again. Not a checkbox:
 *      erasing the record is losing the only information that allowed finding
 *      what still runs.
 */

type Blocker = {
  deploymentId: string;
  version: number;
  status: string;
  runtime: 'docker' | 'k3s';
  reason: 'live' | 'in_progress';
  message: string;
  targetName: string;
  targetHost: string;
  workspace: string;
  publishedPort: number | null;
};

type Preview = {
  applicationSlug: string;
  workspace: string;
  blockers: Blocker[];
  historyCount: number;
  reservedPorts: Array<{ targetName: string; port: number }>;
  missingPermissions: string[];
  canCascade: boolean;
};

type Abandoned = {
  deploymentId: string;
  version: number;
  targetName: string;
  targetHost: string;
  workspace: string;
  publishedPort: number | null;
  error: string;
};

type CascadeResult = {
  deleted: boolean;
  forced: boolean;
  destroyed: Array<{ version: number; targetName: string }>;
  abandoned: Abandoned[];
  purgedCount: number;
  releasedPorts: Array<{ targetName: string; port: number }>;
  summary: string;
};

type JobStatus = {
  state: string;
  result: CascadeResult | null;
  failedReason: string | null;
};

type ApiError = { error?: { message?: string } };

const POLL_MS = 2000;

export function DeleteApplicationDialog({
  application,
  open,
  onOpenChange,
  onDeleted,
}: {
  application: { id: string; slug: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const tChrome = useT(chrome);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [outcome, setOutcome] = useState<CascadeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [confirm, setConfirm] = useState('');

  /** A pure read: it returns the preview or throws, it writes no state. */
  const fetchPreview = useCallback(async (): Promise<Preview> => {
    const response = await fetch(`/api/applications/${application.id}/cascade`);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      throw new Error(body.error?.message ?? tc('http.failure', { status: response.status }));
    }
    return (await response.json()) as Preview;
  }, [application.id, tc]);

  // The modal is mounted on opening and unmounted on closing: the state starts from
  // scratch on its own, there is nothing to reset here.
  useEffect(() => {
    let cancelled = false;
    fetchPreview().then(
      (result) => {
        if (!cancelled) setPreview(result);
      },
      (cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : t('delete.readFailed'));
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [fetchPreview, t]);

  /** Erases directly: nothing runs any more, only history is left. */
  async function eraseHistory() {
    setPending(true);
    setError(null);
    const response = await fetch(`/api/applications/${application.id}`, { method: 'DELETE' });
    setPending(false);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      setError(body.error?.message ?? tc('http.failure', { status: response.status }));
      // The guard may have changed its mind since the preview: something may have been
      // redeployed in the meantime.
      fetchPreview().then(setPreview, () => {});
      return;
    }
    onOpenChange(false);
    onDeleted();
  }

  async function cascade(force: boolean) {
    setPending(true);
    setError(null);
    setProgress(force ? t('delete.progress.force') : t('delete.progress.cascade'));

    const response = await fetch(`/api/applications/${application.id}/cascade`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(force ? { force: true, confirm } : { force: false }),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      setError(body.error?.message ?? tc('http.failure', { status: response.status }));
      setPending(false);
      setProgress(null);
      return;
    }

    const { jobId } = (await response.json()) as { jobId: string };
    const outcomeOrError = await waitForJob(application.id, jobId, setProgress, {
      failed: t('delete.job.failed'),
      progress: (state) => t('delete.job.progress', { state }),
    });
    setPending(false);
    setProgress(null);

    if (outcomeOrError.result === null) {
      setError(outcomeOrError.error ?? t('delete.job.silent'));
      return;
    }
    if (outcomeOrError.result.deleted) {
      onOpenChange(false);
      onDeleted();
      return;
    }
    // Partial failure: the application is intact, we name what resisted.
    setOutcome(outcomeOrError.result);
    setError(outcomeOrError.result.summary);
    setConfirm('');
  }

  const blockers = preview?.blockers ?? [];
  const abandoned = outcome?.abandoned ?? [];
  // Destroying (cascade) and forcing the erasure require typing the name again:
  // they are the two gestures that lose data on a machine.
  const needsName = abandoned.length > 0 || blockers.length > 0;
  const armed = !needsName || confirmMatches(confirm, application.slug);
  const inputId = `delete-${application.id}`;

  return (
    <Dialog open={open} onOpenChange={pending ? () => {} : onOpenChange}>
      <DialogContent size="wide" role="alertdialog">
        <DialogHeader icon={<Trash2 />}>
          <DialogTitle>
            {blockers.length > 0 || abandoned.length > 0
              ? t('delete.title.cascade', { slug: application.slug })
              : t('delete.title', { slug: application.slug })}
          </DialogTitle>
        </DialogHeader>
        <DialogBody>
          <DialogDescription>
            {abandoned.length > 0
              ? t('delete.description.abandoned')
              : blockers.length > 0
                ? t('delete.description.blockers')
                : t('delete.description.history')}
          </DialogDescription>

          {error ? <Alert variant="destructive">{error}</Alert> : null}

          {preview === null && error === null ? <p>{t('delete.loading')}</p> : null}

          {preview !== null && abandoned.length === 0 ? (
            <>
              {blockers.length > 0 ? (
                <div className="well flex flex-col gap-1.5">
                  <span className="t-cap font-semibold text-text">{t('delete.live')}</span>
                  <ul className="bul t-sm flex flex-col gap-1">
                    {blockers.map((blocker) => (
                      <li key={blocker.deploymentId}>
                        <span className="mono">v{blocker.version}</span>{' '}
                        {t('delete.blocker.on', { target: blocker.targetName })}
                        <span className="mono text-text-3">
                          {' '}
                          {blocker.targetHost}
                          {blocker.publishedPort === null
                            ? ''
                            : t('delete.blocker.port', { port: blocker.publishedPort })}
                        </span>
                        <span className="t-cap block text-text-3">{blocker.message}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <ul className="bul t-sm flex flex-col gap-1">
                <li>
                  {blockers.length === 0
                    ? t('delete.historyOnly', { count: preview.historyCount })
                    : t('delete.blockers', {
                        count: blockers.length,
                        lines: t('delete.blockers.lines', { count: preview.historyCount }),
                      })}
                </li>
                {preview.reservedPorts.length > 0 ? (
                  <li>
                    {t('delete.releasedPorts', {
                      count: preview.reservedPorts.length,
                      list: preview.reservedPorts
                        .map((entry) => `${entry.port} (${entry.targetName})`)
                        .join(', '),
                    })}
                  </li>
                ) : null}
              </ul>
              {blockers.length > 0 && !preview.canCascade ? (
                <Alert variant="warn">
                  {t('delete.cascadePermissions.before')}
                  {preview.missingPermissions.map((permission, index) => (
                    <span key={permission}>
                      {index > 0 ? ', ' : ''}
                      <code className="mono">{permission}</code>
                    </span>
                  ))}
                  {t('delete.cascadePermissions.after')}
                </Alert>
              ) : null}
            </>
          ) : null}

          {abandoned.length > 0 ? (
            <>
              <Alert variant="destructive" title={t('delete.abandoned', { count: abandoned.length })}>
                <ul className="bul mt-1.5 flex flex-col gap-1">
                  {abandoned.map((residue) => (
                    <li key={residue.deploymentId}>
                      <span className="mono">{residue.workspace}</span>{' '}
                      {t('delete.blocker.on', { target: residue.targetName })}{' '}
                      <span className="mono">
                        {residue.targetHost}
                        {residue.publishedPort === null
                          ? ''
                          : t('delete.blocker.port', { port: residue.publishedPort })}
                      </span>
                      <span className="t-cap block opacity-80">{residue.error}</span>
                    </li>
                  ))}
                </ul>
              </Alert>
              {outcome !== null && outcome.destroyed.length > 0 ? (
                <p>
                  {t('delete.destroyed', {
                    list: outcome.destroyed
                      .map((entry) =>
                        t('delete.destroyed.entry', { version: entry.version, target: entry.targetName }),
                      )
                      .join(', '),
                  })}
                </p>
              ) : null}
              <p className="t-cap text-text-3">{t('delete.auditNote')}</p>
            </>
          ) : null}

          {needsName && preview !== null ? (
            <div className="field">
              <label htmlFor={inputId} className="label">
                {withSlot(
                  (slot) =>
                    abandoned.length > 0
                      ? `${t('delete.retype.before')}${slot}${t('delete.retype.after')}`
                      : tChrome('confirm.retype', { name: slot }),
                  <span className="mono">{application.slug}</span>,
                )}
              </label>
              <Input
                id={inputId}
                className="mono"
                value={confirm}
                autoComplete="off"
                spellCheck={false}
                autoFocus
                onChange={(event) => setConfirm(event.target.value)}
              />
              <span className="help">{tChrome('confirm.retypeHelp')}</span>
            </div>
          ) : null}

          {progress !== null ? (
            <p className="inline-flex items-center gap-2 text-accent-text">
              <span className="spinner" aria-hidden />
              {progress}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>
            {tc('cancel')}
          </Button>
          {abandoned.length > 0 ? (
            <>
              <Button variant="secondary" disabled={pending} onClick={() => void cascade(false)}>
                {tc('retry')}
              </Button>
              <Button
                variant="destructive-solid"
                disabled={pending || !armed}
                onClick={() => void cascade(true)}
              >
                {t('delete.action.force')}
              </Button>
            </>
          ) : blockers.length > 0 ? (
            <Button
              variant="destructive-solid"
              disabled={pending || preview === null || !preview.canCascade || !armed}
              loading={pending}
              onClick={() => void cascade(false)}
            >
              {pending ? tc('deleting') : t('delete.action.cascade')}
            </Button>
          ) : (
            <Button
              variant="destructive"
              disabled={pending || preview === null}
              loading={pending}
              onClick={() => void eraseHistory()}
            >
              {pending ? tc('deleting') : tc('delete')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


/**
 * Follows the job until its verdict.
 *
 * On `/api/applications/:id/cascade?jobId=` and not on the queue's generic route:
 * that one requires `job:read`, which someone allowed to delete does not
 * necessarily have.
 */
async function waitForJob(
  applicationId: string,
  jobId: string,
  onProgress: (message: string) => void,
  /** The two sentences the loop needs, already rendered by the caller. */
  words: { failed: string; progress: (state: string) => string },
): Promise<{ result: CascadeResult | null; error: string | null }> {
  // Ten minutes: three unreachable targets each cost a bounded SSH attempt, plus
  // the purge. Far beyond the real case.
  const deadline = Date.now() + 10 * 60_000;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));

    const response = await fetch(
      `/api/applications/${applicationId}/cascade?jobId=${encodeURIComponent(jobId)}`,
    );
    if (!response.ok) continue;

    const status = (await response.json()) as JobStatus;
    if (status.state === 'completed' && status.result !== null) {
      return { result: status.result, error: null };
    }
    if (status.state === 'failed') {
      return { result: null, error: status.failedReason ?? words.failed };
    }
    onProgress(words.progress(status.state));
  }
  return { result: null, error: null };
}
