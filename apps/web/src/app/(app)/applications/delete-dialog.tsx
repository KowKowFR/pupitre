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
      throw new Error(body.error?.message ?? `Échec (HTTP ${response.status})`);
    }
    return (await response.json()) as Preview;
  }, [application.id]);

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
          setError(cause instanceof Error ? cause.message : 'Lecture impossible');
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [fetchPreview]);

  /** Efface directement : plus rien ne tourne, il ne reste que de l'historique. */
  async function eraseHistory() {
    setPending(true);
    setError(null);
    const response = await fetch(`/api/applications/${application.id}`, { method: 'DELETE' });
    setPending(false);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      setError(body.error?.message ?? `Échec (HTTP ${response.status})`);
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
    setProgress(force ? 'Effacement forcé…' : 'Destruction sur les cibles…');

    const response = await fetch(`/api/applications/${application.id}/cascade`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(force ? { force: true, confirm } : { force: false }),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      setError(body.error?.message ?? `Échec (HTTP ${response.status})`);
      setPending(false);
      setProgress(null);
      return;
    }

    const { jobId } = (await response.json()) as { jobId: string };
    const outcomeOrError = await waitForJob(application.id, jobId, setProgress);
    setPending(false);
    setProgress(null);

    if (outcomeOrError.result === null) {
      setError(outcomeOrError.error ?? 'La tâche ne répond plus. Consultez les logs d’activité.');
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
          <DialogTitle>Supprimer « {application.slug} »</DialogTitle>
          <DialogDescription>
            {abandoned.length > 0
              ? 'Une cible n’a pas pu être nettoyée. Lisez ce qui va rester dessus.'
              : blockers.length > 0
                ? 'L’application tourne encore. Elle sera démontée sur ses cibles avant d’être effacée.'
                : 'L’application ne porte plus que de l’historique.'}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-3 text-[0.8125rem]">
          {error ? <Alert variant="destructive">{error}</Alert> : null}

          {preview === null && error === null ? (
            <p className="text-ink-muted">Lecture de ce qui bloque…</p>
          ) : null}

          {preview !== null && abandoned.length === 0 ? (
            <>
              {blockers.length === 0 ? (
                <p className="text-ink">
                  Rien ne tourne : {preview.historyCount} déploiement
                  {preview.historyCount > 1 ? 's' : ''} d’historique
                  {preview.historyCount > 1 ? ' seront effacés' : ' sera effacé'}, avec leurs
                  étapes, leurs logs et leurs scans.
                </p>
              ) : (
                <>
                  <p className="text-ink">
                    {blockers.length} déploiement{blockers.length > 1 ? 's' : ''} encore en place.
                    {blockers.length > 1 ? ' Ils seront détruits' : ' Il sera détruit'} sur
                    {blockers.length > 1 ? ' leurs cibles' : ' sa cible'}, puis tout l’historique
                    ({preview.historyCount} ligne{preview.historyCount > 1 ? 's' : ''}) sera effacé.
                  </p>
                  <ul className="space-y-1.5">
                    {blockers.map((blocker) => (
                      <li
                        key={blocker.deploymentId}
                        className="rounded-md border border-line bg-surface-2/50 px-2.5 py-1.5"
                      >
                        <div className="flex flex-wrap items-center gap-1.5">
                          <CodeBadge>{blocker.workspace}</CodeBadge>
                          <span className="text-ink">sur {blocker.targetName}</span>
                          <span className="font-mono text-[0.6875rem] text-ink-faint">
                            {blocker.targetHost}
                            {blocker.publishedPort === null
                              ? ''
                              : ` · port ${blocker.publishedPort}`}
                          </span>
                        </div>
                        <p className="mt-0.5 text-[0.75rem] text-ink-muted">{blocker.message}</p>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {preview.reservedPorts.length > 0 ? (
                <Alert variant="info">
                  Port{preview.reservedPorts.length > 1 ? 's' : ''} rendu
                  {preview.reservedPorts.length > 1 ? 's' : ''} à leur cible :{' '}
                  {preview.reservedPorts
                    .map((entry) => `${entry.port} (${entry.targetName})`)
                    .join(', ')}
                  .
                </Alert>
              ) : null}

              {blockers.length > 0 && !preview.canCascade ? (
                <Alert variant="warn">
                  La cascade exige en plus{' '}
                  {preview.missingPermissions.map((permission, index) => (
                    <span key={permission}>
                      {index > 0 ? ', ' : ''}
                      <code className="font-mono">{permission}</code>
                    </span>
                  ))}
                  . Demandez ces permissions, ou détruisez les déploiements un par un depuis
                  l’écran des déploiements.
                </Alert>
              ) : null}
            </>
          ) : null}

          {abandoned.length > 0 ? (
            <>
              <Alert variant="destructive">
                <p className="font-medium">
                  {abandoned.length} déploiement{abandoned.length > 1 ? 's' : ''} n’
                  {abandoned.length > 1 ? 'ont' : 'a'} pas pu être détruit
                  {abandoned.length > 1 ? 's' : ''}. Forcer n’arrête rien sur la machine : ce qui
                  suit continuera de tourner, sans que le panel sache le nommer.
                </p>
                <ul className="mt-1.5 space-y-1.5">
                  {abandoned.map((residue) => (
                    <li key={residue.deploymentId}>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <CodeBadge>{residue.workspace}</CodeBadge>
                        <span>sur {residue.targetName}</span>
                        <span className="font-mono text-[0.6875rem]">
                          {residue.targetHost}
                          {residue.publishedPort === null ? '' : ` · port ${residue.publishedPort}`}
                        </span>
                      </div>
                      <p className="text-[0.75rem] opacity-80">{residue.error}</p>
                    </li>
                  ))}
                </ul>
              </Alert>

              {outcome !== null && outcome.destroyed.length > 0 ? (
                <p className="text-ink-muted">
                  Déjà détruit :{' '}
                  {outcome.destroyed
                    .map((entry) => `v${entry.version} sur ${entry.targetName}`)
                    .join(', ')}
                  .
                </p>
              ) : null}

              <p className="text-ink">
                Ces informations partent dans les logs d’activité avant l’effacement — c’est la
                seule trace qui permettra de finir le ménage à la main.
              </p>

              <label className="block space-y-1">
                <span className="text-ink-muted">
                  Retapez <code className="font-mono text-ink">{application.slug}</code> pour
                  débloquer le forçage.
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

          {progress !== null ? <p className="text-ink-muted">{progress}</p> : null}
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
            Annuler
          </Button>

          {abandoned.length > 0 ? (
            <>
              <Button variant="outline" disabled={pending} onClick={() => void cascade(false)}>
                Réessayer
              </Button>
              <Button
                variant="destructive"
                disabled={pending || !forceArmed}
                onClick={() => void cascade(true)}
              >
                Forcer l’effacement
              </Button>
            </>
          ) : blockers.length > 0 ? (
            <Button
              variant="destructive"
              disabled={pending || preview === null || !preview.canCascade}
              onClick={() => void cascade(false)}
            >
              {pending ? 'Suppression…' : `Détruire et supprimer`}
            </Button>
          ) : (
            <Button
              variant="destructive"
              disabled={pending || preview === null}
              onClick={() => void eraseHistory()}
            >
              {pending ? 'Suppression…' : 'Supprimer'}
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
      return { result: null, error: status.failedReason ?? 'tâche en échec' };
    }
    onProgress(`Tâche ${status.state}…`);
  }
  return { result: null, error: null };
}
