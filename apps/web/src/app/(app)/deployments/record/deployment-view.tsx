'use client';

import { useRouter } from 'next/navigation';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Trash2, Undo2 } from 'lucide-react';
import {
  deploymentStepLabel,
  type DeployLogLine,
  type DeploymentStatus,
  type ScanVerdict,
  type SeverityCounts,
} from '@pupitre/core';
import { CommitRef } from '@/components/commit-ref';
import { Led } from '@/components/instrument';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { FieldValue } from '@/components/ui/data';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import { Tab, Tabs } from '@/components/ui/tabs';
import { useLanguage, useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { appConsole } from '@/i18n/messages/console';
import { deployments as messages } from '@/i18n/messages/deployments';
import { sources } from '@/i18n/messages/sources';
import type { CommitSource } from '@/lib/commit';
import type { FormatSettings } from '@/lib/format';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { VerdictBadge } from '../deployments-table';
import { PipelineSteps, type StepView } from '../pipeline-steps';
import { DeploymentStatusBadge, formatDuration } from '../status-badge';
import { SecurityPanel } from './security-panel';

export type { StepView };

export type DeploymentView = {
  id: string;
  status: DeploymentStatus;
  runtime: string;
  version: number;
  url: string | null;
  failedStep: string | null;
  error: string | null;
  applicationSlug: string;
  targetName: string;
  targetHost: string;
  triggeredByEmail: string | null;
  /** The deployed commit, when the run comes from a linked repository. */
  source: CommitSource | null;
  startedAt: string | null;
  finishedAt: string | null;
  canRollback: boolean;
  canDestroy: boolean;
  /** Can ask to stop a stuck deployment — `deployment:purge`. */
  canUnblock: boolean;
  /** `scan:read`: without it, the Security tab does not exist. */
  canReadScans: boolean;
  hasPrevious: boolean;
  autoRollback: boolean;
  /** The restored application version, when the status is `rolled_back`. */
  restoredVersion: string | null;
  /** The run's frozen AppSpec, formatted. `null` if it is missing. */
  spec: string | null;
  /** The scans summary, for the line under the analysis step. */
  scan: { scanners: string[]; verdict: ScanVerdict | null; counts: SeverityCounts } | null;
};

type ApiError = { error?: { message?: string } };

type Connection = 'connecting' | 'live' | 'closed' | 'error';

type TabKey = 'pipeline' | 'security' | 'spec';

const TERMINAL: readonly DeploymentStatus[] = ['success', 'failed', 'rolled_back', 'destroyed'];

/**
 * Following a deployment — the pipeline on the left, the log stream on the
 * right, at the same height.
 *
 * The initial state comes from the server; the `EventSource` takes over. If the
 * stream drops, we reconnect: the SSE route replays the persisted history, so a
 * reconnection leaves no gap.
 */
export function DeploymentDetail({
  deployment: initial,
  steps: initialSteps,
  format,
}: {
  deployment: DeploymentView;
  steps: StepView[];
  format: FormatSettings;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const tConsole = useT(appConsole);
  const router = useRouter();
  const [deployment, setDeployment] = useState(initial);
  const [steps, setSteps] = useState(initialSteps);
  const [lines, setLines] = useState<DeployLogLine[]>([]);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [autoScroll, setAutoScroll] = useState(true);
  const [action, setAction] = useState<'rollback' | 'destroy' | 'unblock' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'rollback' | 'destroy' | null>(null);
  const [tab, setTab] = useState<TabKey>('pipeline');

  const logRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const retryRef = useRef<NodeJS.Timeout | null>(null);
  const attemptRef = useRef(0);
  /**
   * The reconnection loop must call `connect` again, which is not declared yet at
   * this point. We go through a ref rather than the binding itself: the scheduled
   * function thus always stays the most recent one.
   */
  const connectRef = useRef<(() => void) | null>(null);

  const isTerminal = TERMINAL.includes(deployment.status);

  const connect = useCallback(() => {
    if (sourceRef.current) sourceRef.current.close();

    const source = new EventSource(`/api/deployments/${deployment.id}/logs`);
    sourceRef.current = source;
    // No synchronous `setState` here: `connect` is called from an effect, and every
    // state change goes through the EventSource's listeners, which are asynchronous
    // callbacks.

    source.addEventListener('open', () => {
      attemptRef.current = 0;
      setConnection('live');
    });

    // The route replays the history at each connection: we start again from an empty
    // list so as not to stack duplicates after a reconnection.
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
                  status: payload.status as StepView['status'],
                  error: payload.status === 'failed' ? payload.detail : step.error,
                  startedAt:
                    payload.status === 'running' ? new Date().toISOString() : step.startedAt,
                  finishedAt: payload.status === 'running' ? null : new Date().toISOString(),
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
      // Reloads the server data: final URL, durations, definitive steps.
      router.refresh();
    });

    source.addEventListener('error', () => {
      // `EventSource` reconnects on its own, but without a bound or a backoff. We take
      // control back to space out the attempts.
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
    // Even on an already finished deployment: the route replays the persisted
    // history then closes the stream by itself.
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

  const language = useLanguage();
  const runningStep = useMemo(() => {
    const running = steps.find((step) => step.status === 'running');
    return running ? deploymentStepLabel(running.key, language, running.label) : null;
  }, [steps, language]);
  const failedStepLabel = useMemo(() => {
    const failed = steps.find((step) => step.status === 'failed');
    return failed ? deploymentStepLabel(failed.key, language, failed.label) : null;
  }, [steps, language]);

  const scanStep = useMemo(() => steps.find((step) => step.key === 'scan') ?? null, [steps]);
  /**
   * Reloads the Security tab when the scan step moves, or when the deployment
   * ends. No polling: it is the SSE stream that triggers.
   */
  const securityKey = `${scanStep?.status ?? 'none'}:${deployment.status}`;

  const settled = steps.filter(
    (step) => step.status === 'success' || step.status === 'skipped',
  ).length;
  const succeeded = steps.filter((step) => step.status === 'success').length;

  async function call(path: string, kind: 'rollback' | 'destroy' | 'unblock') {
    setAction(kind);
    setActionError(null);

    const response = await fetch(path, { method: kind === 'destroy' ? 'DELETE' : 'POST' });
    setAction(null);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      const message = body.error?.message ?? tc('http.failure', { status: response.status });
      // A refusal stays in the dialog when one is open; otherwise, a box under the
      // summary.
      setActionError(message);
      return;
    }
    setConfirm(null);
    if (kind === 'rollback') {
      toast({ title: t('rollback.toast', { slug: deployment.applicationSlug }), tone: 'accent' });
    } else if (kind === 'destroy') {
      toast({
        title: t('destroy.toast', {
          slug: deployment.applicationSlug,
          target: deployment.targetName,
        }),
        tone: 'accent',
      });
    }
    setLines([]);
    connect();
    router.refresh();
  }

  return (
    <>
      <Summary
        deployment={deployment}
        connection={connection}
        step={runningStep ?? failedStepLabel}
        action={action}
        settled={settled}
        total={steps.length}
        onRollback={() => {
          setActionError(null);
          setConfirm('rollback');
        }}
        onDestroy={() => {
          setActionError(null);
          setConfirm('destroy');
        }}
        onUnblock={() => void call(`/api/deployments/${deployment.id}/unblock`, 'unblock')}
      />

      {actionError && confirm === null ? <Alert variant="destructive">{actionError}</Alert> : null}

      <Tabs label={t('tab.label')}>
        <Tab selected={tab === 'pipeline'} onClick={() => setTab('pipeline')}>
          {t('tab.pipeline')}
        </Tab>
        {deployment.canReadScans ? (
          <Tab
            selected={tab === 'security'}
            onClick={() => setTab('security')}
            count={deployment.scan?.scanners.length || undefined}
          >
            {t('tab.security')}
          </Tab>
        ) : null}
        <Tab selected={tab === 'spec'} onClick={() => setTab('spec')}>
          {t('tab.spec')}
        </Tab>
      </Tabs>

      {tab === 'security' && deployment.canReadScans ? (
        <SecurityPanel deploymentId={deployment.id} refreshKey={securityKey} />
      ) : tab === 'spec' ? (
        <section className="card overflow-hidden">
          <div className="card-h">
            <h2>{t('tab.spec')}</h2>
            <span className="sub">{t('spec.note')}</span>
          </div>
          <div className="card-b">
            {deployment.spec ? (
              <pre className="codeblock max-h-[36rem]">{deployment.spec}</pre>
            ) : (
              <p className="t-sm text-text-3">{t('spec.none')}</p>
            )}
          </div>
        </section>
      ) : (
        <div className="grid grid-cols-1 items-stretch gap-5 lg:grid-cols-[336px_minmax(0,1fr)]">
          <section className="card h-fit">
            <div className="card-h">
              <h2>{t('pipeline.title')}</h2>
              <span className="t-cap num ml-auto text-text-3">
                {t('pipeline.succeeded', { done: succeeded, total: steps.length })}
              </span>
            </div>
            <div className="card-b">
              <PipelineSteps
                steps={steps}
                format={format}
                detail={(step) =>
                  step.key === 'scan' && deployment.scan && step.status !== 'pending' ? (
                    <span className="flex flex-wrap items-center gap-1.5">
                      <VerdictBadge verdict={deployment.scan.verdict} />
                      <span className="t-cap text-text-3">
                        {t('step.detail.scan', {
                          critical: deployment.scan.counts.CRITICAL,
                          high: deployment.scan.counts.HIGH,
                        })}
                      </span>
                    </span>
                  ) : step.status === 'running' ? (
                    <span className="t-cap text-accent-text">{t('step.running')}…</span>
                  ) : null
                }
              />
            </div>
          </section>

          {/*
            The terminal is positioned absolutely in its cell: it is the pipeline
            that gives the row its height, and the stream scrolls inside instead
            of lengthening the page.
                     */}
          <div className="relative min-h-[30rem] min-w-0">
            <section className="term absolute inset-0" aria-label={t('logs.title')}>
              <div className="term-h">
                <span className="flex shrink-0 items-center gap-2">
                  <Led
                    tone={
                      connection === 'live' ? 'accent' : connection === 'error' ? 'danger' : 'idle'
                    }
                    pulse={connection === 'live' && !isTerminal}
                  />
                  <span className="font-semibold text-term-fg">{t('logs.title')}</span>
                </span>
                <span
                  className={cn(
                    'mono min-w-0 truncate text-[11.5px]',
                    connection === 'error' && 'text-term-err',
                  )}
                >
                  {t('logs.lines', { count: lines.length })} · {t(`connection.${connection}`)}
                </span>
                <span className="ml-auto flex shrink-0 items-center gap-2.5">
                  <label className="flex items-center gap-1.5 text-term-head max-sm:hidden">
                    <Switch
                      checked={autoScroll}
                      onChange={(event) => setAutoScroll(event.target.checked)}
                    />
                    {t('logs.autoScroll')}
                  </label>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="sm" variant="ghost" className="btn-term">
                        <Download aria-hidden />
                        {t('logs.export')}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-72">
                      {/*
                        Links to the route are enough: it answers with an
                        attachment, and reads the log again in the database —
                        not the displayed buffer, which only contains what the
                        stream replayed since the page opened.
                                             */}
                      <DropdownMenuItem asChild>
                        <a href={`/api/deployments/${deployment.id}/logs/export?format=text`}>
                          .log
                          <span className="t-cap ml-auto text-text-3">{t('logs.export.text')}</span>
                        </a>
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild>
                        <a href={`/api/deployments/${deployment.id}/logs/export?format=jsonl`}>
                          .jsonl
                          <span className="t-cap ml-auto text-text-3">
                            {t('logs.export.jsonl')}
                          </span>
                        </a>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel className="t-cap font-normal text-text-3">
                        {t('logs.export.scope')}
                      </DropdownMenuLabel>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </span>
              </div>
              <div
                ref={logRef}
                role="log"
                tabIndex={0}
                aria-label={t('logs.title')}
                className="term-b min-h-0"
                onScroll={(event) => {
                  const element = event.currentTarget;
                  setAutoScroll(
                    element.scrollHeight - element.scrollTop - element.clientHeight < 40,
                  );
                }}
              >
                {lines.length === 0 ? (
                  <p className="px-3.5 text-term-dim">
                    {isTerminal ? t('logs.empty.settled') : t('logs.empty.waiting')}
                  </p>
                ) : (
                  lines.map((line, index) => (
                    <div
                      key={`${line.ts}-${index}`}
                      className={cn('ln', line.stream === 'stderr' && 'is-err')}
                    >
                      <span className="ts tabular-nums select-none">{line.ts.slice(11, 19)}</span>
                      <span className="sv max-w-[7rem] truncate select-none">{line.step}</span>
                      <span className={cn('min-w-0', line.stream === 'stderr' && 'e')}>
                        {line.line}
                      </span>
                    </div>
                  ))
                )}
                {connection === 'live' && !isTerminal ? (
                  <div className="ln" aria-hidden>
                    <span className="ts invisible">00:00:00</span>
                    <span className="cursor" />
                  </div>
                ) : null}
              </div>
            </section>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirm === 'rollback'}
        onOpenChange={(open) => (open ? undefined : setConfirm(null))}
        level="reversible"
        icon={<Undo2 />}
        tone="accent"
        title={t('rollback.title')}
        description={t('rollback.lead', {
          slug: deployment.applicationSlug,
          target: deployment.targetName,
        })}
        consequences={[
          tConsole('rollback.noRebuild'),
          tConsole('rollback.status'),
          tConsole('rollback.volumes'),
        ]}
        confirmLabel={tConsole('rollback.confirm')}
        pendingLabel={t('action.rollback.pending')}
        pending={action === 'rollback'}
        error={confirm === 'rollback' ? actionError : null}
        onConfirm={() => call(`/api/deployments/${deployment.id}/rollback`, 'rollback')}
      />

      <ConfirmDialog
        open={confirm === 'destroy'}
        onOpenChange={(open) => (open ? undefined : setConfirm(null))}
        level="data"
        icon={<Trash2 />}
        title={tConsole('destroy.title', {
          slug: deployment.applicationSlug,
          target: deployment.targetName,
        })}
        description={tConsole('destroy.lead')}
        consequences={[
          tConsole('destroy.volumes'),
          tConsole('destroy.releases'),
          tConsole('destroy.kept'),
        ]}
        retypeName={deployment.applicationSlug}
        confirmLabel={tConsole('destroy.confirm')}
        pendingLabel={t('action.destroy.pending')}
        pending={action === 'destroy'}
        error={confirm === 'destroy' ? actionError : null}
        onConfirm={() => call(`/api/deployments/${deployment.id}`, 'destroy')}
      />
    </>
  );
}

/**
 * A run's summary. Everything one wants to know before reading the logs: the
 * state, what on what, for how long, at which step, where it answers, who
 * started it. The 3 px bar at the bottom tells the progress; it sweeps while the
 * worker works and freezes as soon as the run is finished.
 */
function Summary({
  deployment,
  connection,
  step,
  action,
  settled,
  total,
  onRollback,
  onDestroy,
  onUnblock,
}: {
  deployment: DeploymentView;
  connection: Connection;
  step: string | null;
  action: string | null;
  settled: number;
  total: number;
  onRollback: () => void;
  onDestroy: () => void;
  onUnblock: () => void;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const ts = useT(sources);
  const failed = deployment.status === 'failed';
  const rolledBack = deployment.status === 'rolled_back';
  const running = deployment.status === 'running' || deployment.status === 'pending';
  const ratio = total === 0 ? 0 : Math.round((settled / total) * 100);

  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-4 px-[18px] py-4">
        <div className="flex flex-col items-start gap-1">
          <DeploymentStatusBadge status={deployment.status} />
          <span className="t-sm text-text-2">
            <span className="mono">{deployment.targetName}</span> · {deployment.runtime}
          </span>
        </div>
        <span className="vsep max-md:hidden" />
        <FieldValue label={t('field.duration')}>
          <span className="num" suppressHydrationWarning>
            {formatDuration(deployment.startedAt, deployment.finishedAt)}
          </span>
        </FieldValue>
        {step ? (
          <FieldValue label={t('field.step')}>
            <span className={cn(running && 'text-accent-text', failed && 'text-danger-text')}>
              {step}
            </span>
          </FieldValue>
        ) : null}
        {deployment.url ? (
          <FieldValue label={t('field.address')}>
            <a href={deployment.url} target="_blank" rel="noreferrer" className="link mono">
              {deployment.url.replace(/^https?:\/\//, '')}
            </a>
          </FieldValue>
        ) : null}
        {deployment.source ? (
          <FieldValue label={ts('run.source')}>
            <CommitRef source={deployment.source} />
          </FieldValue>
        ) : null}
        <FieldValue label={t('field.by')}>
          <span className="mono">{deployment.triggeredByEmail ?? tc('none')}</span>
        </FieldValue>

        <div className="ml-auto flex shrink-0 flex-wrap gap-2">
          {(failed || rolledBack) && deployment.canRollback && deployment.hasPrevious ? (
            <Button size="sm" variant="secondary" disabled={action !== null} onClick={onRollback}>
              <Undo2 aria-hidden />
              {t('action.rollback')}
            </Button>
          ) : null}
          {/*
            The button is offered unconditionally on a deployment in progress:
            the screen has no way of knowing whether the job is still alive, and
            finding out would cost a read of the queue at each display. It is the
            route that decides, and its refusal explains why — "your job has been
            active for four minutes". A button that asks a question is better
            than a button that guesses.
                     */}
          {running && deployment.canUnblock ? (
            <Button
              size="sm"
              variant="ghost"
              loading={action === 'unblock'}
              disabled={action !== null}
              onClick={onUnblock}
            >
              {action === 'unblock' ? tc('checking') : t('action.unblock')}
            </Button>
          ) : null}
          {deployment.canDestroy && connection !== 'live' && deployment.status !== 'destroyed' ? (
            <Button size="sm" variant="destructive" disabled={action !== null} onClick={onDestroy}>
              {t('action.destroy')}…
            </Button>
          ) : null}
        </div>
      </div>

      {deployment.error ||
      rolledBack ||
      (failed && deployment.autoRollback && !deployment.hasPrevious) ? (
        <div className="flex flex-col gap-2 border-t border-border-subtle px-[18px] py-3">
          {deployment.error ? (
            <p
              className={cn(
                'mono text-[11.5px] leading-relaxed break-words',
                rolledBack ? 'text-warn-text' : 'text-danger-text',
              )}
            >
              {deployment.failedStep ? `${deployment.failedStep} : ` : ''}
              {deployment.error}
            </p>
          ) : null}
          {rolledBack ? (
            <p className="t-sm text-warn-text">
              {deployment.restoredVersion
                ? t('banner.restored.version', { version: deployment.restoredVersion })
                : t('banner.restored')}
            </p>
          ) : null}
          {failed && deployment.autoRollback && !deployment.hasPrevious ? (
            <p className="t-sm text-text-2">{t('banner.noFallback')}</p>
          ) : null}
        </div>
      ) : null}

      <div
        className="h-[3px] w-full bg-surface-3"
        role="progressbar"
        aria-label={t('progress.label')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={ratio}
      >
        <div
          className={cn(
            'h-full transition-[width] duration-500 ease-out motion-reduce:transition-none',
            failed
              ? 'bg-danger'
              : rolledBack
                ? 'bg-warn'
                : deployment.status === 'success'
                  ? 'bg-ok'
                  : 'bg-accent',
          )}
          style={{ width: `${Math.max(ratio, running ? 4 : 0)}%` }}
        />
      </div>
    </section>
  );
}
