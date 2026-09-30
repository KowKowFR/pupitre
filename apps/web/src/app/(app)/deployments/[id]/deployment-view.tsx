'use client';

import { useRouter } from 'next/navigation';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { deploymentStepLabel, type DeployLogLine, type DeploymentStatus, type StepStatus } from '@pupitre/core';
import { Led } from '@/components/instrument';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useLanguage, useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { deployments as messages } from '@/i18n/messages/deployments';
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
  const t = useT(messages);
  const tc = useT(common);
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

  /**
   * Le nom d'une étape se rend à partir de sa clé, pas du libellé que la base
   * a figé au moment d'enfiler le job : sans cela, un pipeline lancé en
   * français resterait français dans un panel passé à l'anglais. Le libellé
   * stocké ne sert plus que de dernier recours, pour une étape que le
   * catalogue ne connaît plus.
   */
  const language = useLanguage();
  const runningStep = useMemo(() => {
    const running = steps.find((step) => step.status === 'running');
    return running ? deploymentStepLabel(running.key, language, running.label) : null;
  }, [steps, language]);

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
      setActionError(body.error?.message ?? tc('http.failure', { status: response.status }));
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

      <div className="flex gap-1 border-b border-border">
        <TabButton active={tab === 'pipeline'} onClick={() => setTab('pipeline')}>
          {t('tab.pipeline')}
        </TabButton>
        <TabButton active={tab === 'security'} onClick={() => setTab('security')}>
          {t('tab.security')}
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
            <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
              <span className="eyebrow text-text-3">{t('pipeline.title')}</span>
              <span className="font-mono text-[0.6875rem] text-text-2 tabular-nums">
                {t('pipeline.succeeded', { done: succeeded, total: steps.length })}
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
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border px-5 py-3.5">
              <div className="flex items-center gap-2">
                <span className="eyebrow text-text-3">{t('logs.title')}</span>
                <span className="font-mono text-[0.6875rem] text-text-2 tabular-nums">
                  {t('logs.lines', { count: lines.length })}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <ExportLinks deploymentId={deployment.id} />
                <ConnectionLabel state={connection} />
                <label
                  className={cn(
                    'flex cursor-pointer items-center gap-1.5 rounded-sm border px-2 py-1 text-[0.6875rem] transition-colors',
                    autoScroll
                      ? 'border-accent-line bg-accent-soft/60 text-accent'
                      : 'border-border text-text-3 hover:text-text-2',
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
                      autoScroll ? 'bg-accent' : 'bg-text-3/50',
                    )}
                  />
                  {t('logs.autoScroll')}
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
              className="h-[30rem] overflow-y-auto bg-term-bg px-4 py-3 font-mono text-[0.6875rem] leading-[1.65] text-term-fg"
            >
              {lines.length === 0 ? (
                <p className="text-term-dim">
                  {isTerminal ? t('logs.empty.settled') : t('logs.empty.waiting')}
                </p>
              ) : (
                lines.map((line, index) => (
                  <div
                    key={`${line.ts}-${index}`}
                    className={cn(
                      'flex gap-3 break-words whitespace-pre-wrap',
                      line.stream === 'stderr' && 'text-term-err',
                    )}
                  >
                    <span className="shrink-0 tabular-nums text-term-dim select-none">
                      {line.ts.slice(11, 19)}
                    </span>
                    <span className="w-24 shrink-0 truncate text-term-dim select-none">
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
  const language = useLanguage();
  const running = step.status === 'running';
  const done = step.status === 'success';

  return (
    <li
      className={cn(
        'relative flex items-start gap-3 rounded-md py-2 pr-2 pl-2.5 transition-colors duration-200',
        running && 'bg-accent-soft/45',
      )}
    >
      {running ? (
        <span
          aria-hidden
          className="absolute top-1.5 bottom-1.5 left-0 w-[2px] rounded-full bg-accent"
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
            done ? 'bg-ok/50' : 'bg-border-strong/70',
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
            step.status === 'pending' && 'text-text-3',
            step.status === 'skipped' && 'text-text-3 line-through',
            step.status === 'success' && 'text-text',
            step.status === 'failed' && 'font-medium text-text',
            running && 'font-medium text-text',
          )}
        >
          {deploymentStepLabel(step.key, language, step.label)}
        </div>
        {step.error ? (
          <div className="mt-1 rounded-sm border border-danger-line bg-danger-soft/50 px-2 py-1 font-mono text-[0.6875rem] leading-relaxed break-words text-danger-text">
            {step.error}
          </div>
        ) : null}
      </div>

      {step.startedAt && step.status !== 'pending' ? (
        <span className="shrink-0 pt-0.5 font-mono text-[0.625rem] text-text-3 tabular-nums">
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
        active ? 'font-medium text-text' : 'text-text-2 hover:text-text',
      )}
    >
      {children}
      <span
        aria-hidden
        className={cn(
          'absolute inset-x-2 -bottom-px h-[2px] rounded-full transition-colors duration-200',
          active ? 'bg-accent' : 'bg-transparent',
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
  const t = useT(messages);
  const formats = [
    { value: 'text', label: '.log', hint: t('logs.export.text') },
    { value: 'jsonl', label: '.jsonl', hint: t('logs.export.jsonl') },
  ] as const;

  return (
    <div className="flex items-center gap-1.5 text-[0.6875rem]">
      <span className="text-text-3">{t('logs.export')}</span>
      {formats.map((format) => (
        <a
          key={format.value}
          href={`/api/deployments/${deploymentId}/logs/export?format=${format.value}`}
          title={t('logs.export.title', { hint: format.hint })}
          className="rounded-sm border border-border px-1.5 py-0.5 font-mono text-text-2 transition-colors hover:border-accent-line hover:text-text"
        >
          {format.label}
        </a>
      ))}
    </div>
  );
}

function ConnectionLabel({ state }: { state: 'connecting' | 'live' | 'closed' | 'error' }) {
  const t = useT(messages);
  const label = {
    connecting: t('connection.connecting'),
    live: t('connection.live'),
    closed: t('connection.closed'),
    error: t('connection.error'),
  }[state];

  const tone = state === 'live' ? 'signal' : state === 'error' ? 'danger' : 'idle';

  return (
    <span
      className={cn(
        'flex items-center gap-1.5 text-[0.6875rem]',
        state === 'error' ? 'text-danger-text' : 'text-text-2',
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
  const t = useT(messages);
  const tc = useT(common);
  const failed = deployment.status === 'failed';
  const rolledBack = deployment.status === 'rolled_back';
  const running = deployment.status === 'running' || deployment.status === 'pending';
  const ratio = total === 0 ? 0 : Math.round((settled / total) * 100);

  return (
    <Card
      className={cn(
        'gap-0 overflow-hidden py-0',
        failed && 'border-danger-line',
        rolledBack && 'border-warn-line',
        deployment.status === 'success' && 'border-ok-line',
      )}
    >
      <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-4 px-5 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <DeploymentStatusBadge status={deployment.status} />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-text">
              {deployment.applicationSlug}{' '}
              <span className="font-mono font-normal text-text-3">v{deployment.version}</span>
            </div>
            <div className="truncate font-mono text-[0.6875rem] text-text-3">
              {deployment.targetName} · {deployment.runtime} · {deployment.proxy}
            </div>
          </div>
        </div>

        <dl className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <Field label={tc('column.duration')}>
            <span className="tabular-nums">
              {formatDuration(deployment.startedAt, deployment.finishedAt)}
            </span>
          </Field>
          {runningStep ? (
            <Field label={t('field.step')}>
              <span className="text-accent">{runningStep}…</span>
            </Field>
          ) : null}
          {deployment.url ? (
            <Field label={t('field.address')}>
              <a
                href={deployment.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-accent underline decoration-accent-line underline-offset-4 hover:decoration-accent"
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
              {action === 'rollback' ? t('action.rollback.pending') : t('action.rollback')}
            </Button>
          ) : null}
          {deployment.canDestroy && connection !== 'live' && deployment.status !== 'destroyed' ? (
            <Button size="sm" variant="ghost" disabled={action !== null} onClick={onDestroy}>
              {action === 'destroy' ? t('action.destroy.pending') : t('action.destroy')}
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
              {action === 'unblock' ? tc('checking') : t('action.unblock')}
            </Button>
          ) : null}
        </div>
      </CardContent>

      {deployment.error || rolledBack || (failed && deployment.autoRollback && !deployment.hasPrevious) ? (
        <div className="flex flex-col gap-2 border-t border-border px-5 py-3">
          {deployment.error ? (
            <p
              className={cn(
                'font-mono text-[0.6875rem] leading-relaxed break-words',
                rolledBack ? 'text-warn-text' : 'text-danger-text',
              )}
            >
              {deployment.failedStep ? `${deployment.failedStep} : ` : ''}
              {deployment.error}
            </p>
          ) : null}
          {rolledBack ? (
            <p className="text-xs text-warn-text">
              {deployment.restoredVersion
                ? t('banner.restored.version', { version: deployment.restoredVersion })
                : t('banner.restored')}
            </p>
          ) : null}
          {failed && deployment.autoRollback && !deployment.hasPrevious ? (
            <p className="text-xs text-text-2">{t('banner.noFallback')}</p>
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
            running && 'animate-sweep',
            failed
              ? 'bg-danger'
              : rolledBack
                ? 'bg-warn'
                : deployment.status === 'success'
                  ? 'bg-ok'
                  : 'bg-[linear-gradient(90deg,var(--accent-line),var(--accent),var(--accent-line))]',
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
      <dt className="eyebrow text-text-3">{label}</dt>
      <dd className="font-mono text-xs text-text-2">{children}</dd>
    </div>
  );
}
