'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { CodeBadge } from '@/components/ui/badge';
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

/**
 * Confirmation de suppression d'une application.
 *
 * Trois écrans dans une seule modale, parce que ce sont trois moments d'un même
 * geste et qu'on ne renvoie pas l'utilisateur ailleurs entre deux :
 *
 *   1. **Rien ne bloque** — l'application ne porte que de l'historique. On dit
 *      combien de lignes partent et quels ports sont rendus, et on efface.
 *   2. **Quelque chose tourne** — on nomme chaque déploiement encore en place :
 *      la cible, le projet Compose, le port. La cascade ira les détruire.
 *   3. **Une cible a résisté** — on nomme ce qui restera sur la machine, et le
 *      forçage se débloque en retapant le nom de l'application. Pas une case à
 *      cocher : effacer l'enregistrement, c'est perdre la seule information qui
 *      permettait de retrouver ce qui tourne encore.
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
  const [preview, setPreview] = useState<Preview | null>(null);
  const [outcome, setOutcome] = useState<CascadeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [confirm, setConfirm] = useState('');

  /** Lecture pure : elle rend la prévisualisation ou lève, elle n'écrit aucun état. */
  const fetchPreview = useCallback(async (): Promise<Preview> => {
    const response = await fetch(`/api/applications/${application.id}/cascade`);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      throw new Error(body.error?.message ?? tc('http.failure', { status: response.status }));
    }
    return (await response.json()) as Preview;
  }, [application.id, tc]);

  // La modale est montée à l'ouverture et démontée à la fermeture : l'état
  // repart de zéro tout seul, il n'y a rien à réinitialiser ici.
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

  /** Efface directement : plus rien ne tourne, il ne reste que de l'historique. */
  async function eraseHistory() {
    setPending(true);
    setError(null);
    const response = await fetch(`/api/applications/${application.id}`, { method: 'DELETE' });
    setPending(false);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      setError(body.error?.message ?? tc('http.failure', { status: response.status }));
      // La garde a peut-être changé d'avis depuis la prévisualisation : quelque
      // chose a pu être redéployé entre-temps.
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
    // Échec partiel : l'application est intacte, on nomme ce qui a résisté.
    setOutcome(outcomeOrError.result);
    setError(outcomeOrError.result.summary);
    setConfirm('');
  }

  const blockers = preview?.blockers ?? [];
  const abandoned = outcome?.abandoned ?? [];
  const forceArmed = confirm.trim() === application.slug;

  return (
    <Dialog open={open} onOpenChange={pending ? () => {} : onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('delete.title', { slug: application.slug })}</DialogTitle>
          <DialogDescription>
            {abandoned.length > 0
              ? t('delete.description.abandoned')
              : blockers.length > 0
                ? t('delete.description.blockers')
                : t('delete.description.history')}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-3 text-[0.8125rem]">
          {error ? <Alert variant="destructive">{error}</Alert> : null}

          {preview === null && error === null ? (
            <p className="text-text-2">{t('delete.loading')}</p>
          ) : null}

          {preview !== null && abandoned.length === 0 ? (
            <>
              {blockers.length === 0 ? (
                <p className="text-text">
                  {t('delete.historyOnly', { count: preview.historyCount })}
                </p>
              ) : (
                <>
                  <p className="text-text">
                    {t('delete.blockers', {
                      count: blockers.length,
                      lines: t('delete.blockers.lines', { count: preview.historyCount }),
                    })}
                  </p>
                  <ul className="space-y-1.5">
                    {blockers.map((blocker) => (
                      <li
                        key={blocker.deploymentId}
                        className="rounded-md border border-border bg-surface-2/50 px-2.5 py-1.5"
                      >
                        <div className="flex flex-wrap items-center gap-1.5">
                          <CodeBadge>{blocker.workspace}</CodeBadge>
                          <span className="text-text">
                            {t('delete.blocker.on', { target: blocker.targetName })}
                          </span>
                          <span className="font-mono text-[0.6875rem] text-text-3">
                            {blocker.targetHost}
                            {blocker.publishedPort === null
                              ? ''
                              : t('delete.blocker.port', { port: blocker.publishedPort })}
                          </span>
                        </div>
                        <p className="mt-0.5 text-[0.75rem] text-text-2">{blocker.message}</p>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {preview.reservedPorts.length > 0 ? (
                <Alert variant="info">
                  {t('delete.releasedPorts', {
                    count: preview.reservedPorts.length,
                    list: preview.reservedPorts
                      .map((entry) => `${entry.port} (${entry.targetName})`)
                      .join(', '),
                  })}
                </Alert>
              ) : null}

              {blockers.length > 0 && !preview.canCascade ? (
                <Alert variant="warn">
                  {t('delete.cascadePermissions.before')}
                  {preview.missingPermissions.map((permission, index) => (
                    <span key={permission}>
                      {index > 0 ? ', ' : ''}
                      <code className="font-mono">{permission}</code>
                    </span>
                  ))}
                  {t('delete.cascadePermissions.after')}
                </Alert>
              ) : null}
            </>
          ) : null}

          {abandoned.length > 0 ? (
            <>
              <Alert variant="destructive">
                <p className="font-medium">{t('delete.abandoned', { count: abandoned.length })}</p>
                <ul className="mt-1.5 space-y-1.5">
                  {abandoned.map((residue) => (
                    <li key={residue.deploymentId}>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <CodeBadge>{residue.workspace}</CodeBadge>
                        <span>{t('delete.blocker.on', { target: residue.targetName })}</span>
                        <span className="font-mono text-[0.6875rem]">
                          {residue.targetHost}
                          {residue.publishedPort === null
                            ? ''
                            : t('delete.blocker.port', { port: residue.publishedPort })}
                        </span>
                      </div>
                      <p className="text-[0.75rem] opacity-80">{residue.error}</p>
                    </li>
                  ))}
                </ul>
              </Alert>

              {outcome !== null && outcome.destroyed.length > 0 ? (
                <p className="text-text-2">
                  {t('delete.destroyed', {
                    list: outcome.destroyed
                      .map((entry) =>
                        t('delete.destroyed.entry', {
                          version: entry.version,
                          target: entry.targetName,
                        }),
                      )
                      .join(', '),
                  })}
                </p>
              ) : null}

              <p className="text-text">{t('delete.auditNote')}</p>

              <label className="block space-y-1">
                <span className="text-text-2">
                  {t('delete.retype.before')}
                  <code className="font-mono text-text">{application.slug}</code>
                  {t('delete.retype.after')}
                </span>
                <Input
                  value={confirm}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setConfirm(event.target.value)}
                />
              </label>
            </>
          ) : null}

          {progress !== null ? <p className="text-text-2">{progress}</p> : null}
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
            {tc('cancel')}
          </Button>

          {abandoned.length > 0 ? (
            <>
              <Button variant="outline" disabled={pending} onClick={() => void cascade(false)}>
                {tc('retry')}
              </Button>
              <Button
                variant="destructive"
                disabled={pending || !forceArmed}
                onClick={() => void cascade(true)}
              >
                {t('delete.action.force')}
              </Button>
            </>
          ) : blockers.length > 0 ? (
            <Button
              variant="destructive"
              disabled={pending || preview === null || !preview.canCascade}
              onClick={() => void cascade(false)}
            >
              {pending ? tc('deleting') : t('delete.action.cascade')}
            </Button>
          ) : (
            <Button
              variant="destructive"
              disabled={pending || preview === null}
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
 * Suit la tâche jusqu'à son verdict.
 *
 * Sur `/api/applications/:id/cascade?jobId=` et non sur la route générique de
 * la file : celle-ci exige `job:read`, que quelqu'un ayant le droit de
 * supprimer n'a pas forcément.
 */
async function waitForJob(
  applicationId: string,
  jobId: string,
  onProgress: (message: string) => void,
  /** Les deux phrases dont la boucle a besoin, déjà rendues par l'appelant. */
  words: { failed: string; progress: (state: string) => string },
): Promise<{ result: CascadeResult | null; error: string | null }> {
  // Dix minutes : trois cibles injoignables coûtent chacune une tentative SSH
  // bornée, plus la purge. Très au-delà du cas réel.
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
