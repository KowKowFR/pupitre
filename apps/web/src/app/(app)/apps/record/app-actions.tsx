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
 * A running application's operating gestures.
 *
 * Four gestures, and they are not alike:
 *
 *   Stop / Start         cuts and restores the service, without dismantling
 *                        anything.
 *   Back to #n-1         puts the previous release back in service, already
 *                        present on the machine.
 *   Redeploy             replays a complete pipeline from the same AppSpec —
 *                        useful when a mutable image moved or a secret
 *                        changed.
 *   Destroy              removes the application from the machine.
 *
 * ── Why this component calls routes that already existed ────────────────────
 * Rollback, redeployment and destruction each have their route, their
 * permission, their BullMQ job and their audit trace — they serve the
 * *deployment* screen. Opening twins under `/api/apps/…` would have given two
 * doors to the same gesture, hence two places where a rule can diverge. What was
 * missing was not a route, it was an entrance from the application's screen, and
 * a dialog that says what the gesture is going to do.
 *
 * ── The state comes from a read, not from the props ─────────────────────────
 * After a stop, the button must become "Start" without reloading the page — the
 * neighboring log console would lose its SSE connection. Hence `GET
 * /api/apps/{id}/state`, read again after each gesture until the state flips.
 *
 * ── The permissions ─────────────────────────────────────────────────────────
 * `canDestroy` corresponds exactly to `deployment:destroy`. `canDeploy` covers
 * the three other buttons, whose routes respectively require
 * `deployment:restart` (stop and start), `deployment:rollback` and
 * `deployment:create`. The shipped roles do not separate them — an operator has
 * all three, a viewer none — but a custom role could, and it would then see a
 * button whose route will refuse it. The refusal is clean and named; it is the
 * server that has authority, never the display.
 */

export type AppActionsProps = {
  deploymentId: string;
  applicationId: string;
  applicationSlug: string;
  targetName: string;
  runtime: 'docker' | 'k3s';
  /** The version declared by the frozen spec, when it declares one. */
  specVersion: string | null;
  format: FormatSettings;
  canDeploy: boolean;
  canDestroy: boolean;
};

/** What `GET /api/apps/{id}/state` returns. */
type AppState = {
  id: string;
  status: string;
  supervisable: boolean;
  stoppedAt: string | null;
  /** Number of the run in service, global to the instance. */
  number: number;
  version: number;
  url: string | null;
  publishedPort: number | null;
  applicationId: string;
  targetId: string;
  targetName: string;
  runtime: 'docker' | 'k3s';
  /** Compose project or namespace, depending on the runtime. */
  workspace: string;
  previous: { id: string; number: number; version: number } | null;
};

type ApiError = { error?: { message?: string } };

type GestureKey = 'stop' | 'start' | 'rollback' | 'redeploy' | 'destroy';

type Gesture = {
  key: GestureKey;
  label: string;
  /** Label while the job runs. */
  busyLabel: string;
  icon: ReactNode;
  variant: 'default' | 'secondary' | 'destructive';
  /** Prevents the gesture and says why, without hiding it. */
  disabledReason: string | null;
  request: { path: string; method: 'POST' | 'DELETE'; body?: unknown };
  confirm: {
    title: string;
    lead?: string;
    /** What is going to happen, by name. */
    consequences: ReactNode[];
    action: string;
    level: 'reversible' | 'data';
    icon: ReactNode;
    tone?: DialogTone;
    /** The gesture only unlocks by typing this name again. */
    retypeName?: string;
  } | null;
  /** What the toast says once the state has flipped. */
  done: { title: string; description?: string };
  /**
   * The gesture leaves this screen rather than wait on it: a redeployment creates
   * a new deployment, and it is its pipeline that must be watched.
   */
  navigateTo?: (response: { id?: string }) => string;
};

type T = Translate<typeof appConsole.fr>;

/** Cadence and cap of the state re-reading after a gesture. */
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
   * Waits for the state to flip.
   *
   * The route returns `202`: it queued, it executed nothing. The only reliable
   * witness of the work's end is the state read in the database, written by the
   * worker once the gesture went through on the machine. So we read it again until
   * it changes — and stop after three minutes saying so, rather than going round in
   * circles in front of a stopped worker.
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
              // The server page carries the health banner and the header: they must follow
              // the gesture that was just made.
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
            // A failed read is not a failure of the gesture: we try again.
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
        // The refusal stays in the dialog when there is one: that is where one looks. A
        // gesture without a dialog says it through a toast.
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
                ? t('ops.version.spec', { number: state.number, spec: specVersion })
                : t('ops.version', { number: state.number })}
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
 * The gestures table, derived from the read state.
 *
 * It is a function and not a constant array because each label names something
 * concrete — the version one goes back to, the port that will be released, the
 * namespace that will disappear. A confirmation dialog that says "are you sure?"
 * confirms nothing at all.
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
        // Starting again destroys nothing and interrupts nothing: asking for a
        // confirmation for that is learning to click without reading.
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
            // The word comes from the dictionary, indexed by runtime: what each one calls
            // stopping is not the same thing.
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
      ? t('gesture.rollback', { number: state.previous.number })
      : t('gesture.rollback.none'),
    busyLabel: t('busy.rollback'),
    icon: <Undo2 aria-hidden />,
    variant: 'secondary',
    disabledReason: state.previous ? null : t('rollback.none'),
    request: { path: `/api/deployments/${state.id}/rollback`, method: 'POST' },
    confirm: state.previous
      ? {
          title: t('rollback.title', { number: state.previous.number }),
          lead: t('rollback.lead', {
            number: state.previous.number,
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
    navigateTo: (body) =>
      body.id ? `/deployments?run=${body.id}` : `/applications?app=${applicationId}`,
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

/** A translated sentence two of whose values keep their formatting (mono). */
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
