'use client';

import { useRouter } from 'next/navigation';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import type { DeployLogLine, DeploymentStatus, StepStatus } from '@pupitre/core';
import { Led } from '@/components/instrument';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { DeploymentStatusBadge, StepIcon, formatDuration } from '../status-badge';
import { SecurityPanel } from './security-panel';

export type StepView = {
  key: string;
  label: string;
  status: StepStatus;
  order: number;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};

export type DeploymentView = {
  id: string;
  status: DeploymentStatus;
  runtime: string;
  proxy: string;
  version: number;
  url: string | null;
  failedStep: string | null;
  error: string | null;
  applicationSlug: string;
  targetName: string;
  targetHost: string;
  startedAt: string | null;
  finishedAt: string | null;
  canRollback: boolean;
  canDestroy: boolean;
  /** Peut demander l'arrêt d'un déploiement figé — `deployment:purge`. */
  canUnblock: boolean;
  hasPrevious: boolean;
  autoRollback: boolean;
  /** Version applicative restaurée, quand le statut est `rolled_back`. */
  restoredVersion: string | null;
};

type ApiError = { error?: { message?: string } };

const TERMINAL: readonly DeploymentStatus[] = ['success', 'failed', 'rolled_back', 'destroyed'];

/**
 * Suivi d'un déploiement — steps à gauche, logs à droite.
 *
 * L'état initial vient du serveur ; l'`EventSource` prend le relais. Si le flux
 * tombe, on se reconnecte : la route SSE rejoue l'historique persisté, donc une
 * reconnexion ne laisse pas de trou.
 */
export function DeploymentDetail({
  deployment: initial,
  steps: initialSteps,
}: {
  deployment: DeploymentView;
  steps: StepView[];
}) {
  const router = useRouter();
  const [deployment, setDeployment] = useState(initial);
  const [steps, setSteps] = useState(initialSteps);
  const [lines, setLines] = useState<DeployLogLine[]>([]);
  const [connection, setConnection] = useState<'connecting' | 'live' | 'closed' | 'error'>(
    'connecting',
  );
  const [autoScroll, setAutoScroll] = useState(true);
  const [action, setAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [tab, setTab] = useState<'pipeline' | 'security'>('pipeline');

  const logRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const retryRef = useRef<NodeJS.Timeout | null>(null);
  const attemptRef = useRef(0);
  /**
   * La boucle de reconnexion doit rappeler `connect`, qui n'est pas encore
   * déclaré à cet endroit. On passe par une ref plutôt que par la liaison
   * elle-même : la fonction planifiée reste ainsi toujours la plus récente.
   */
  const connectRef = useRef<(() => void) | null>(null);

  const isTerminal = TERMINAL.includes(deployment.status);

  const connect = useCallback(() => {
    if (sourceRef.current) sourceRef.current.close();

    const source = new EventSource(`/api/deployments/${deployment.id}/logs`);
    sourceRef.current = source;
    // Aucun `setState` synchrone ici : `connect` est appelé depuis un effet, et
    // tout changement d'état passe par les écouteurs de l'EventSource, qui sont
    // des rappels asynchrones.

    source.addEventListener('open', () => {
      attemptRef.current = 0;
      setConnection('live');
    });

    // La route rejoue l'historique à chaque connexion : on repart d'une liste
    // vide pour ne pas empiler les doublons après une reconnexion.
    source.addEventListener('replayed', () => setConnection('live'));

    source.addEventListener('status', (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as {
        status: DeploymentStatus;
        url: string | null;
        failedStep: string | null;
      };
      setLines([]);
      setDeployment((current) => ({ ...current, ...payload }));
    });

    source.addEventListener('log', (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as DeployLogLine;
      setLines((current) => [...current, payload]);
    });

    source.addEventListener('event', (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as {
        type: 'step' | 'deployment';
        key: string;
        status: string;
        detail: string | null;
      };

      if (payload.type === 'step') {
        setSteps((current) =>
          current.map((step) =>
            step.key === payload.key
              ? {
                  ...step,
                  status: payload.status as StepStatus,
                  error: payload.status === 'failed' ? payload.detail : step.error,
                  startedAt:
                    payload.status === 'running' ? new Date().toISOString() : step.startedAt,
                  finishedAt:
                    payload.status === 'running' ? null : new Date().toISOString(),
                }
              : step,
          ),
        );
        return;
      }

      setDeployment((current) => ({
        ...current,
        status: payload.status as DeploymentStatus,
        ...(payload.detail && payload.status === 'success' ? { url: payload.detail } : {}),
      }));
    });

    source.addEventListener('end', () => {
      setConnection('closed');
      source.close();
      sourceRef.current = null;
      // Recharge les données serveur : URL finale, durées, étapes définitives.
      router.refresh();
    });

    source.addEventListener('error', () => {
      // `EventSource` se reconnecte seul, mais sans borne ni recul. On reprend
      // la main pour espacer les tentatives.
      if (source.readyState === EventSource.CLOSED) {
        setConnection('error');
        source.close();
        sourceRef.current = null;

        attemptRef.current += 1;
        const delay = Math.min(1000 * 2 ** (attemptRef.current - 1), 15_000);
        retryRef.current = setTimeout(() => connectRef.current?.(), delay);
      }
    });
  }, [deployment.id, router]);

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  useEffect(() => {
    // Même sur un déploiement déjà terminé : la route rejoue l'historique
    // persisté puis ferme le flux d'elle-même.
    connect();
    return () => {
      if (retryRef.current) clearTimeout(retryRef.current);
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, [connect]);

  useEffect(() => {
    if (!autoScroll) return;
    const element = logRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [lines, autoScroll]);

  const runningStep = useMemo(
    () => steps.find((step) => step.status === 'running')?.label ?? null,
    [steps],
  );

  const scanStep = useMemo(() => steps.find((step) => step.key === 'scan') ?? null, [steps]);
  /**
   * Recharge l'onglet Sécurité quand l'étape de scan bouge, ou quand le
   * déploiement se termine. Pas de sondage : c'est le flux SSE qui déclenche.
   */
  const securityKey = `${scanStep?.status ?? 'none'}:${deployment.status}`;

  const settled = steps.filter(
    (step) => step.status === 'success' || step.status === 'skipped',
  ).length;
  const succeeded = steps.filter((step) => step.status === 'success').length;

  async function call(path: string, label: string) {
    setAction(label);
    setActionError(null);

    const response = await fetch(path, { method: label === 'destroy' ? 'DELETE' : 'POST' });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      setActionError(body.error?.message ?? `Échec (HTTP ${response.status})`);
      setAction(null);
      return;
    }
    setAction(null);
    setLines([]);
    connect();
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-5">
      <StatusBanner
        deployment={deployment}
        connection={connection}
        runningStep={runningStep}
        action={action}
        settled={settled}
        total={steps.length}
        onRollback={() => void call(`/api/deployments/${deployment.id}/rollback`, 'rollback')}
        onDestroy={() => void call(`/api/deployments/${deployment.id}`, 'destroy')}
        onUnblock={() => void call(`/api/deployments/${deployment.id}/unblock`, 'unblock')}
      />

      {actionError ? <Alert variant="destructive">{actionError}</Alert> : null}

      <div className="flex gap-1 border-b border-line">
        <TabButton active={tab === 'pipeline'} onClick={() => setTab('pipeline')}>
          Pipeline
        </TabButton>
        <TabButton active={tab === 'security'} onClick={() => setTab('security')}>
          Sécurité
          {scanStep && scanStep.status !== 'pending' ? (
            <StepIcon status={scanStep.status} className="size-3.5" />
          ) : null}
        </TabButton>
      </div>

      {tab === 'security' ? (
        <SecurityPanel deploymentId={deployment.id} refreshKey={securityKey} />
      ) : (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,21rem)_minmax(0,1fr)]">
          <Card className="h-fit gap-0 py-0">
            <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
              <span className="eyebrow text-ink-faint">Pipeline</span>
              <span className="font-mono text-[0.6875rem] text-ink-muted tabular-nums">
                {succeeded}/{steps.length} réussies
              </span>
            </div>
            <CardContent className="px-3 py-3">
              <ol className="relative">
                {steps.map((step, index) => (
                  <StepRow
                    key={step.key}
                    step={step}
                    last={index === steps.length - 1}
                  />
                ))}
              </ol>
            </CardContent>
          </Card>

          <Card className="flex min-h-0 flex-col gap-0 overflow-hidden py-0">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-5 py-3.5">
              <div className="flex items-center gap-2">
                <span className="eyebrow text-ink-faint">Flux de logs</span>
                <span className="font-mono text-[0.6875rem] text-ink-muted tabular-nums">
                  {lines.length} ligne{lines.length > 1 ? 's' : ''}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <ExportLinks deploymentId={deployment.id} />
                <ConnectionLabel state={connection} />
                <label
                  className={cn(
                    'flex cursor-pointer items-center gap-1.5 rounded-sm border px-2 py-1 text-[0.6875rem] transition-colors',
                    autoScroll
                      ? 'border-signal-edge bg-signal-soft/60 text-signal'
                      : 'border-line text-ink-faint hover:text-ink-muted',
                  )}
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={autoScroll}
                    onChange={(event) => setAutoScroll(event.target.checked)}
                  />
                  <span
                    aria-hidden
                    className={cn(
                      'size-1.5 rounded-full transition-colors',
                      autoScroll ? 'bg-signal' : 'bg-ink-faint/50',
                    )}
                  />
                  défilement auto
                </label>
              </div>
            </div>
            <div
              ref={logRef}
              onScroll={(event) => {
                const element = event.currentTarget;
                const atBottom =
                  element.scrollHeight - element.scrollTop - element.clientHeight < 40;
                setAutoScroll(atBottom);
              }}
              className="h-[30rem] overflow-y-auto bg-terminal px-4 py-3 font-mono text-[0.6875rem] leading-[1.65] text-terminal-fg"
            >
              {lines.length === 0 ? (
                <p className="text-terminal-dim">
                  {isTerminal
                    ? 'Aucun log conservé pour ce déploiement.'
                    : 'En attente du worker…'}
                </p>
              ) : (
                lines.map((line, index) => (
                  <div
                    key={`${line.ts}-${index}`}
                    className={cn(
                      'flex gap-3 break-words whitespace-pre-wrap',
                      line.stream === 'stderr' && 'text-terminal-danger',
                    )}
                  >
                    <span className="shrink-0 tabular-nums text-terminal-dim select-none">
                      {line.ts.slice(11, 19)}
                    </span>
                    <span className="w-24 shrink-0 truncate text-terminal-dim select-none">
                      {line.step}
                    </span>
                    <span className="min-w-0">{line.line}</span>
                  </div>
                ))
              )}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

/**
 * Une étape du pipeline.
 *
 * Le trait vertical qui relie les pastilles se colore jusqu'à l'étape courante :
 * l'avancement se lit sur la colonne elle-même, sans compter les coches. L'étape
 * en cours est posée sur un liseré de signal — le seul endroit accentué de la
 * colonne, donc l'œil y revient tout seul.
 */
function StepRow({ step, last }: { step: StepView; last: boolean }) {
  const running = step.status === 'running';
  const done = step.status === 'success';

  return (
    <li
      className={cn(
        'relative flex items-start gap-3 rounded-md py-2 pr-2 pl-2.5 transition-colors duration-200',
        running && 'bg-signal-soft/45',
      )}
    >
      {running ? (
        <span
          aria-hidden
          className="absolute top-1.5 bottom-1.5 left-0 w-[2px] rounded-full bg-signal"
        />
      ) : null}

      {/*
       * Montant de l'échelle. Positionné sur le `li` et débordant de sa marge
       * basse, il rejoint la pastille suivante sans interruption, quelle que
       * soit la hauteur de la ligne (une étape en échec porte son message).
       */}
      {last ? null : (
        <span
          aria-hidden
          className={cn(
            'absolute top-[1.75rem] -bottom-2 left-[1.125rem] w-[2px] rounded-full transition-colors duration-300',
            done ? 'bg-ok/50' : 'bg-line-strong/70',
          )}
        />
      )}

      <div className="relative flex flex-col items-center">
        <StepIcon status={step.status} />
      </div>

      <div className="min-w-0 flex-1 pb-0.5">
        <div
          className={cn(
            'text-[0.8125rem] leading-5 transition-colors duration-200',
            step.status === 'pending' && 'text-ink-faint',
            step.status === 'skipped' && 'text-ink-faint line-through',
            step.status === 'success' && 'text-ink',
            step.status === 'failed' && 'font-medium text-ink',
            running && 'font-medium text-ink',
          )}
        >
          {step.label}
        </div>
        {step.error ? (
          <div className="mt-1 rounded-sm border border-danger-edge bg-danger-soft/50 px-2 py-1 font-mono text-[0.6875rem] leading-relaxed break-words text-danger">
            {step.error}
          </div>
        ) : null}
      </div>

      {step.startedAt && step.status !== 'pending' ? (
        <span className="shrink-0 pt-0.5 font-mono text-[0.625rem] text-ink-faint tabular-nums">
          {formatDuration(step.startedAt, step.finishedAt)}
        </span>
      ) : null}
    </li>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'relative flex items-center gap-2 px-4 py-2 text-[0.8125rem] transition-colors duration-100',
        active ? 'font-medium text-ink' : 'text-ink-muted hover:text-ink',
      )}
    >
      {children}
      <span
        aria-hidden
        className={cn(
          'absolute inset-x-2 -bottom-px h-[2px] rounded-full transition-colors duration-200',
          active ? 'bg-signal' : 'bg-transparent',
        )}
      />
    </button>
  );
}

/**
 * Export du journal persisté.
 *
 * Un lien vers la route suffit : elle répond en `attachment`, le navigateur
 * fait le reste — pas de `Blob` à fabriquer ni d'objet URL à révoquer. Le
 * libellé dit « complet » parce que le fichier l'est : la route relit
 * `deployment_steps.log`, pas le tampon affiché à droite, qui ne contient que
 * ce que le flux SSE a rejoué depuis l'ouverture de la page.
 */
function ExportLinks({ deploymentId }: { deploymentId: string }) {
  const formats = [
    { value: 'text', label: '.log', hint: 'texte horodaté, lisible' },
    { value: 'jsonl', label: '.jsonl', hint: 'une ligne = un objet JSON' },
  ] as const;

  return (
    <div className="flex items-center gap-1.5 text-[0.6875rem]">
      <span className="text-ink-faint">Exporter le journal complet</span>
      {formats.map((format) => (
        <a
          key={format.value}
          href={`/api/deployments/${deploymentId}/logs/export?format=${format.value}`}
          title={`Toutes les lignes conservées en base pour ce déploiement (${format.hint}) — pas seulement celles affichées ci-dessous.`}
          className="rounded-sm border border-line px-1.5 py-0.5 font-mono text-ink-muted transition-colors hover:border-signal-edge hover:text-ink"
        >
          {format.label}
        </a>
      ))}
    </div>
  );
}

function ConnectionLabel({ state }: { state: 'connecting' | 'live' | 'closed' | 'error' }) {
  const label = {
    connecting: 'connexion…',
    live: 'flux en direct',
    closed: 'flux terminé',
    error: 'reconnexion…',
  }[state];

  const tone = state === 'live' ? 'signal' : state === 'error' ? 'danger' : 'idle';

  return (
    <span
      className={cn(
        'flex items-center gap-1.5 text-[0.6875rem]',
        state === 'error' ? 'text-danger' : 'text-ink-muted',
      )}
    >
      <Led tone={tone} pulse={state === 'live'} className="size-2" />
      {label}
    </span>
  );
}

/**
 * En-tête de run. Tout ce qu'on veut savoir avant de lire les logs : l'état,
 * quoi sur quoi, depuis combien de temps, et où ça répond.
 */
function StatusBanner({
  deployment,
  connection,
  runningStep,
  action,
  settled,
  total,
  onRollback,
  onDestroy,
  onUnblock,
}: {
  deployment: DeploymentView;
  connection: string;
  runningStep: string | null;
  action: string | null;
  settled: number;
  total: number;
  onRollback: () => void;
  onDestroy: () => void;
  onUnblock: () => void;
}) {
  const failed = deployment.status === 'failed';
  const rolledBack = deployment.status === 'rolled_back';
  const running = deployment.status === 'running' || deployment.status === 'pending';
  const ratio = total === 0 ? 0 : Math.round((settled / total) * 100);

  return (
    <Card
      className={cn(
        'gap-0 overflow-hidden py-0',
        failed && 'border-danger-edge',
        rolledBack && 'border-warn-edge',
        deployment.status === 'success' && 'border-ok-edge',
      )}
    >
      <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-4 px-5 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <DeploymentStatusBadge status={deployment.status} />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-ink">
              {deployment.applicationSlug}{' '}
              <span className="font-mono font-normal text-ink-faint">v{deployment.version}</span>
            </div>
            <div className="truncate font-mono text-[0.6875rem] text-ink-faint">
              {deployment.targetName} · {deployment.runtime} · {deployment.proxy}
            </div>
          </div>
        </div>

        <dl className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <Field label="Durée">
            <span className="tabular-nums">
              {formatDuration(deployment.startedAt, deployment.finishedAt)}
            </span>
          </Field>
          {runningStep ? (
            <Field label="Étape">
              <span className="text-signal">{runningStep}…</span>
            </Field>
          ) : null}
          {deployment.url ? (
            <Field label="Adresse">
              <a
                href={deployment.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-signal underline decoration-signal-edge underline-offset-4 hover:decoration-signal"
              >
                {deployment.url}
                <ExternalLink className="size-3" />
              </a>
            </Field>
          ) : null}
        </dl>

        <div className="ml-auto flex shrink-0 gap-2">
          {(failed || rolledBack) && deployment.canRollback && deployment.hasPrevious ? (
            <Button size="sm" variant="outline" disabled={action !== null} onClick={onRollback}>
              {action === 'rollback' ? 'Rollback…' : 'Revenir à la version précédente'}
            </Button>
          ) : null}
          {deployment.canDestroy && connection !== 'live' && deployment.status !== 'destroyed' ? (
            <Button size="sm" variant="ghost" disabled={action !== null} onClick={onDestroy}>
              {action === 'destroy' ? 'Destruction…' : 'Détruire'}
            </Button>
          ) : null}
          {/*
            Le bouton est proposé sans condition sur un déploiement en cours :
            l'écran n'a aucun moyen de savoir si la tâche vit encore, et le
            découvrir coûterait une lecture de la file à chaque affichage. C'est
            la route qui tranche, et son refus explique pourquoi — « votre tâche
            est active depuis quatre minutes ». Un bouton qui pose une question
            vaut mieux qu'un bouton qui devine.
          */}
          {running && deployment.canUnblock ? (
            <Button size="sm" variant="ghost" disabled={action !== null} onClick={onUnblock}>
              {action === 'unblock' ? 'Vérification…' : 'Ce déploiement est figé ?'}
            </Button>
          ) : null}
        </div>
      </CardContent>

      {deployment.error || rolledBack || (failed && deployment.autoRollback && !deployment.hasPrevious) ? (
        <div className="flex flex-col gap-2 border-t border-line px-5 py-3">
          {deployment.error ? (
            <p
              className={cn(
                'font-mono text-[0.6875rem] leading-relaxed break-words',
                rolledBack ? 'text-warn' : 'text-danger',
              )}
            >
              {deployment.failedStep ? `${deployment.failedStep} : ` : ''}
              {deployment.error}
            </p>
          ) : null}
          {rolledBack ? (
            <p className="text-xs text-warn">
              {deployment.restoredVersion
                ? `Version ${deployment.restoredVersion} restaurée — le service répond.`
                : 'Version précédente restaurée — le service répond.'}
            </p>
          ) : null}
          {failed && deployment.autoRollback && !deployment.hasPrevious ? (
            <p className="text-xs text-ink-muted">
              Rollback automatique demandé, mais aucune version antérieure sur cette cible.
            </p>
          ) : null}
        </div>
      ) : null}

      {/*
       * Jauge d'avancement, collée au bas du panneau. Elle balaye tant que le
       * worker travaille et se fige dès que le run est terminé — un seul point
       * animé dans tout l'écran hors du flux de logs.
       */}
      <div className="h-[3px] w-full bg-surface-2">
        <div
          className={cn(
            'h-full transition-[width] duration-500 ease-out',
            running && 'animate-signal-sweep',
            failed
              ? 'bg-danger'
              : rolledBack
                ? 'bg-warn'
                : deployment.status === 'success'
                  ? 'bg-ok'
                  : 'bg-[linear-gradient(90deg,var(--signal-edge),var(--signal),var(--signal-edge))]',
          )}
          style={{ width: `${Math.max(ratio, running ? 4 : 0)}%` }}
        />
      </div>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="eyebrow text-ink-faint">{label}</dt>
      <dd className="font-mono text-xs text-ink-muted">{children}</dd>
    </div>
  );
}
