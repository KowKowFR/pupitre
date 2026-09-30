'use client';

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Play, RefreshCw, Square, Trash2, Undo2 } from 'lucide-react';
import type { Translate } from '@pupitre/core';
import { Alert } from '@/components/ui/alert';
import { ActionRow, Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import type { DialogTone } from '@/components/ui/dialog';
import { useT } from '@/i18n/client';
import { appConsole } from '@/i18n/messages/console';
import { formatDateTime, type FormatSettings } from '@/lib/format';
import { toast } from '@/lib/toast';

/**
 * Les gestes d'exploitation d'une application en marche.
 *
 * Quatre gestes, et ils ne se ressemblent pas :
 *
 *   Arrêter / Démarrer   coupe et remet le service, sans rien démonter.
 *   Revenir à #n-1       remet en service la release précédente, déjà présente
 *                        sur la machine.
 *   Redéployer           rejoue un pipeline complet depuis la même AppSpec —
 *                        utile quand une image mutable a bougé ou qu'un secret
 *                        a changé.
 *   Détruire             retire l'application de la machine.
 *
 * ── Pourquoi ce composant appelle des routes qui existaient déjà ────────────
 * Rollback, redéploiement et destruction ont chacun leur route, leur
 * permission, leur tâche BullMQ et leur trace d'audit — elles servent l'écran
 * du *déploiement*. En ouvrir des jumelles sous `/api/apps/…` aurait donné deux
 * portes vers le même geste, donc deux endroits où une règle peut diverger. Ce
 * qui manquait n'était pas une route, c'était une porte d'entrée depuis l'écran
 * de l'application, et un dialogue qui dise ce que le geste va faire.
 *
 * ── L'état vient d'une lecture, pas des props ───────────────────────────────
 * Après un arrêt, le bouton doit devenir « Démarrer » sans recharger la page —
 * la console de logs voisine perdrait sa connexion SSE. D'où `GET
 * /api/apps/{id}/state`, relu après chaque geste jusqu'à ce que l'état bascule.
 *
 * ── Les permissions ─────────────────────────────────────────────────────────
 * `canDestroy` correspond exactement à `deployment:destroy`. `canDeploy`
 * couvre les trois autres boutons, dont les routes exigent respectivement
 * `deployment:restart` (arrêt et démarrage), `deployment:rollback` et
 * `deployment:create`. Les rôles livrés ne les dissocient pas — un opérateur a
 * les trois, un observateur aucune — mais un rôle sur mesure le pourrait, et il
 * verrait alors un bouton dont la route le refusera. Le refus est propre et
 * nommé ; c'est le serveur qui fait autorité, jamais l'affichage.
 */

export type AppActionsProps = {
  deploymentId: string;
  applicationId: string;
  applicationSlug: string;
  targetName: string;
  runtime: 'docker' | 'k3s';
  /** La version déclarée par la spec figée, quand elle en déclare une. */
  specVersion: string | null;
  format: FormatSettings;
  canDeploy: boolean;
  canDestroy: boolean;
};

/** Ce que rend `GET /api/apps/{id}/state`. */
type AppState = {
  id: string;
  status: string;
  supervisable: boolean;
  stoppedAt: string | null;
  version: number;
  url: string | null;
  publishedPort: number | null;
  applicationId: string;
  targetId: string;
  targetName: string;
  runtime: 'docker' | 'k3s';
  /** Projet Compose ou namespace, selon le runtime. */
  workspace: string;
  previous: { id: string; version: number } | null;
};

type ApiError = { error?: { message?: string } };

type GestureKey = 'stop' | 'start' | 'rollback' | 'redeploy' | 'destroy';

type Gesture = {
  key: GestureKey;
  label: string;
  /** Libellé pendant que la tâche tourne. */
  busyLabel: string;
  icon: ReactNode;
  variant: 'default' | 'secondary' | 'destructive';
  /** Empêche le geste et dit pourquoi, sans le cacher. */
  disabledReason: string | null;
  request: { path: string; method: 'POST' | 'DELETE'; body?: unknown };
  confirm: {
    title: string;
    lead?: string;
    /** Ce qui va se passer, nommément. */
    consequences: ReactNode[];
    action: string;
    level: 'reversible' | 'data';
    icon: ReactNode;
    tone?: DialogTone;
    /** Le geste ne se débloque qu'en retapant ce nom. */
    retypeName?: string;
  } | null;
  /** Ce que le toast dit une fois l'état basculé. */
  done: { title: string; description?: string };
  /**
   * Le geste quitte cet écran plutôt que d'y attendre : un redéploiement crée
   * un nouveau déploiement, et c'est son pipeline qu'il faut regarder.
   */
  navigateTo?: (response: { id?: string }) => string;
};

type T = Translate<typeof appConsole.fr>;

/** Cadence et plafond de la relecture d'état après un geste. */
const POLL_MS = 2_000;
const POLL_MAX_MS = 3 * 60_000;

export function AppActions({
  deploymentId,
  applicationId,
  applicationSlug,
  targetName,
  runtime,
  specVersion,
  format,
  canDeploy,
  canDestroy,
}: AppActionsProps): ReactNode {
  const t = useT(appConsole);
  const router = useRouter();
  const reasonId = useId();
  const [state, setState] = useState<AppState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<GestureKey | null>(null);
  const [pending, setPending] = useState<Gesture | null>(null);

  const timer = useRef<NodeJS.Timeout | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const read = useCallback(async (): Promise<AppState> => {
    const response = await fetch(`/api/apps/${deploymentId}/state`, { cache: 'no-store' });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      throw new Error(body.error?.message ?? t('ops.readFailed', { status: response.status }));
    }
    return (await response.json()) as AppState;
  }, [deploymentId, t]);

  useEffect(() => {
    read().then(
      (result) => {
        if (alive.current) setState(result);
      },
      (cause: unknown) => {
        if (alive.current) {
          setLoadError(cause instanceof Error ? cause.message : t('ops.readFailed.generic'));
        }
      },
    );
  }, [read, t]);

  /**
   * Attend que l'état bascule.
   *
   * La route rend `202` : elle a enfilé, elle n'a rien exécuté. Le seul témoin
   * fiable de la fin du travail est l'état lu en base, écrit par le worker une
   * fois le geste passé sur la machine. On le relit donc jusqu'à ce qu'il
   * change — et on s'arrête au bout de trois minutes en le disant, plutôt que
   * de tourner en rond devant un worker arrêté.
   */
  const watch = useCallback(
    (before: string, done: Gesture['done']) => {
      const started = Date.now();

      const tick = () => {
        read().then(
          (result) => {
            if (!alive.current) return;
            if (`${result.status}|${result.stoppedAt}` !== before) {
              setState(result);
              setBusy(null);
              toast({ ...done, tone: 'ok' });
              // La page serveur porte le bandeau de santé et l'en-tête : ils
              // doivent suivre le geste qu'on vient de passer.
              router.refresh();
              return;
            }
            if (Date.now() - started > POLL_MAX_MS) {
              setBusy(null);
              toast({ title: t('ops.timeout'), tone: 'danger' });
              return;
            }
            timer.current = setTimeout(tick, POLL_MS);
          },
          () => {
            // Une lecture ratée n'est pas un échec du geste : on retente.
            if (alive.current) timer.current = setTimeout(tick, POLL_MS);
          },
        );
      };

      timer.current = setTimeout(tick, POLL_MS);
    },
    [read, router, t],
  );

  const run = useCallback(
    async (gesture: Gesture, current: AppState) => {
      setError(null);
      setBusy(gesture.key);

      const response = await fetch(gesture.request.path, {
        method: gesture.request.method,
        ...(gesture.request.body === undefined
          ? {}
          : {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(gesture.request.body),
            }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as ApiError;
        const message = body.error?.message ?? t('ops.failed', { status: response.status });
        setBusy(null);
        // Le refus reste dans le dialogue quand il y en a un : c'est là qu'on
        // regarde. Un geste sans dialogue le dit par un toast.
        if (gesture.confirm) setError(message);
        else toast({ title: message, tone: 'danger' });
        return;
      }

      setPending(null);

      if (gesture.navigateTo) {
        const body = (await response.json().catch(() => ({}))) as { id?: string };
        router.push(gesture.navigateTo(body));
        return;
      }

      watch(`${current.status}|${current.stoppedAt}`, gesture.done);
    },
    [router, t, watch],
  );

  if (loadError) {
    return (
      <div className="card w-full px-3.5 py-3 lg:w-[560px]">
        <Alert variant="destructive">{loadError}</Alert>
      </div>
    );
  }

  const gestures = state
    ? buildGestures({ state, applicationId, applicationSlug, runtime, t })
    : [];
  const visible = gestures.filter((gesture) =>
    gesture.key === 'destroy' ? canDestroy : canDeploy,
  );
  const blocked = visible.find((gesture) => gesture.disabledReason !== null) ?? null;
  const main = visible.filter((gesture) => gesture.key !== 'destroy');
  const destroy = visible.find((gesture) => gesture.key === 'destroy') ?? null;

  return (
    <section
      aria-label={t('ops.label')}
      className="card flex w-full min-w-0 flex-col gap-2.5 px-3.5 py-3 lg:w-[560px]"
    >
      <p className="t-sm">
        {state === null ? (
          <span className="text-text-3">{t('ops.reading')}</span>
        ) : state.stoppedAt !== null ? (
          <>
            <span className="font-semibold text-text">
              {t('ops.stopped', { date: formatDateTime(state.stoppedAt, format) })}
            </span>
            <span className="text-text-3">{t('ops.stopped.detail')}</span>
          </>
        ) : (
          <>
            <span className="font-semibold text-text">
              {t('ops.running', { target: targetName })}
            </span>
            <span className="text-text-3">
              {specVersion
                ? t('ops.version.spec', { version: state.version, spec: specVersion })
                : t('ops.version', { version: state.version })}
            </span>
          </>
        )}
      </p>

      {state === null ? (
        <div className="flex gap-1.5" aria-hidden>
          <span className="sk h-8 w-24" />
          <span className="sk h-8 w-32" />
          <span className="sk h-8 w-28" />
        </div>
      ) : visible.length === 0 ? (
        <p className="t-cap text-text-3">{t('ops.none')}</p>
      ) : (
        <ActionRow
          reason={
            blocked ? (
              <span id={reasonId}>
                <span className="font-medium">{blocked.label}</span> — {blocked.disabledReason}
              </span>
            ) : undefined
          }
        >
          {main.map((gesture) => (
            <Button
              key={gesture.key}
              size="sm"
              variant={gesture.variant}
              loading={busy === gesture.key}
              disabled={busy !== null || gesture.disabledReason !== null}
              aria-describedby={gesture.disabledReason ? reasonId : undefined}
              onClick={() => {
                if (gesture.confirm) {
                  setError(null);
                  setPending(gesture);
                  return;
                }
                void run(gesture, state);
              }}
            >
              {busy === gesture.key ? null : gesture.icon}
              {busy === gesture.key ? gesture.busyLabel : gesture.label}
            </Button>
          ))}
          {destroy ? (
            <Button
              size="sm"
              variant="destructive"
              className="ml-auto"
              loading={busy === 'destroy'}
              disabled={busy !== null}
              onClick={() => {
                setError(null);
                setPending(destroy);
              }}
            >
              {busy === 'destroy' ? destroy.busyLabel : destroy.label}
            </Button>
          ) : null}
        </ActionRow>
      )}

      {pending?.confirm && state ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => (open ? undefined : setPending(null))}
          level={pending.confirm.level}
          icon={pending.confirm.icon}
          tone={pending.confirm.tone}
          title={pending.confirm.title}
          description={pending.confirm.lead}
          consequences={pending.confirm.consequences}
          retypeName={pending.confirm.retypeName}
          confirmLabel={pending.confirm.action}
          pendingLabel={pending.busyLabel}
          pending={busy === pending.key}
          error={error}
          onConfirm={() => run(pending, state)}
        />
      ) : null}
    </section>
  );
}

/**
 * La table des gestes, dérivée de l'état lu.
 *
 * Elle est une fonction et non un tableau constant parce que chaque libellé
 * nomme quelque chose de concret — la version vers laquelle on revient, le port
 * qui sera rendu, le namespace qui disparaîtra. Un dialogue de confirmation qui
 * dit « êtes-vous sûr ? » ne fait rien confirmer du tout.
 */
function buildGestures({
  state,
  applicationId,
  applicationSlug,
  runtime,
  t,
}: {
  state: AppState;
  applicationId: string;
  applicationSlug: string;
  runtime: 'docker' | 'k3s';
  t: T;
}): Gesture[] {
  const stopped = state.stoppedAt !== null;
  const port = state.publishedPort;
  const mono = (value: string) => <span className="mono">{value}</span>;

  const lifecycle: Gesture = stopped
    ? {
        key: 'start',
        label: t('gesture.start'),
        busyLabel: t('busy.start'),
        icon: <Play aria-hidden />,
        variant: 'default',
        disabledReason: null,
        request: { path: `/api/apps/${state.id}/start`, method: 'POST' },
        // Remettre en marche ne détruit rien et n'interrompt rien : demander
        // confirmation pour ça, c'est apprendre à cliquer sans lire.
        confirm: null,
        done: { title: t('toast.start', { slug: applicationSlug }) },
      }
    : {
        key: 'stop',
        label: t('gesture.stop'),
        busyLabel: t('busy.stop'),
        icon: <Square aria-hidden />,
        variant: 'secondary',
        disabledReason: null,
        request: { path: `/api/apps/${state.id}/stop`, method: 'POST' },
        confirm: {
          title: t('stop.title', { slug: applicationSlug, target: state.targetName }),
          consequences: [
            // Le mot vient du dictionnaire, indexé par runtime : ce que chacun
            // appelle arrêter n'est pas la même chose.
            t(`stop.containers.${runtime}`),
            port === null ? t('stop.kept.noPort') : t('stop.kept', { port }),
            t('stop.probe'),
            t('stop.resume'),
          ],
          action: t('stop.confirm'),
          level: 'reversible',
          icon: <Square />,
          tone: 'warn',
        },
        done: {
          title: t('toast.stop', { slug: applicationSlug }),
          description: t('toast.stop.detail'),
        },
      };

  const rollback: Gesture = {
    key: 'rollback',
    label: state.previous
      ? t('gesture.rollback', { version: state.previous.version })
      : t('gesture.rollback.none'),
    busyLabel: t('busy.rollback'),
    icon: <Undo2 aria-hidden />,
    variant: 'secondary',
    disabledReason: state.previous ? null : t('rollback.none'),
    request: { path: `/api/deployments/${state.id}/rollback`, method: 'POST' },
    confirm: state.previous
      ? {
          title: t('rollback.title', { version: state.previous.version }),
          lead: t('rollback.lead', {
            version: state.previous.version,
            target: state.targetName,
          }),
          consequences: [
            t('rollback.noRebuild'),
            t('rollback.status'),
            t('rollback.volumes'),
            ...(stopped ? [t('rollback.restart')] : []),
          ],
          action: t('rollback.confirm'),
          level: 'reversible',
          icon: <Undo2 />,
          tone: 'accent',
        }
      : null,
    done: { title: t('toast.rollback', { slug: applicationSlug }) },
  };

  const redeploy: Gesture = {
    key: 'redeploy',
    label: t('gesture.redeploy'),
    busyLabel: t('busy.redeploy'),
    icon: <RefreshCw aria-hidden />,
    variant: 'secondary',
    disabledReason: null,
    request: {
      path: `/api/applications/${applicationId}/redeploy`,
      method: 'POST',
      body: { versionId: state.id, targetId: state.targetId, autoRollback: true },
    },
    confirm: {
      title: t('redeploy.title'),
      lead: t('redeploy.lead'),
      consequences: [
        t('redeploy.new'),
        t('redeploy.images'),
        t('redeploy.swap'),
        t('redeploy.rollback'),
      ],
      action: t('redeploy.confirm'),
      level: 'reversible',
      icon: <RefreshCw />,
      tone: 'accent',
    },
    done: { title: t('redeploy.confirm') },
    navigateTo: (body) => (body.id ? `/deployments/${body.id}` : `/applications/${applicationId}`),
  };

  const destroy: Gesture = {
    key: 'destroy',
    label: t('gesture.destroy'),
    busyLabel: t('busy.destroy'),
    icon: null,
    variant: 'destructive',
    disabledReason: null,
    request: { path: `/api/deployments/${state.id}`, method: 'DELETE' },
    confirm: {
      title: t('destroy.title', { slug: applicationSlug, target: state.targetName }),
      lead: t('destroy.lead'),
      consequences: [
        withMono(
          t(`destroy.workspace.${runtime}`, { workspace: SLOT_A, target: SLOT_B }),
          mono(state.workspace),
          mono(state.targetName),
        ),
        t('destroy.volumes'),
        port === null ? t('destroy.ingress') : t('destroy.port', { port }),
        t('destroy.releases'),
        t('destroy.kept'),
      ],
      action: t('destroy.confirm'),
      level: 'data',
      icon: <Trash2 />,
      retypeName: applicationSlug,
    },
    done: { title: t('toast.destroy', { slug: applicationSlug, target: state.targetName }) },
  };

  return [lifecycle, rollback, redeploy, destroy];
}

const SLOT_A = '\u0001';
const SLOT_B = '\u0002';

/** Une phrase traduite dont deux valeurs gardent leur mise en forme (mono). */
function withMono(sentence: string, first: ReactNode, second: ReactNode): ReactNode {
  return sentence
    .split(/(\u0001|\u0002)/)
    .map((part, index) =>
      part === SLOT_A ? (
        <span key={index}>{first}</span>
      ) : part === SLOT_B ? (
        <span key={index}>{second}</span>
      ) : (
        part
      ),
    );
}
