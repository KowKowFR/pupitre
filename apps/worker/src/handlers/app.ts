import {
  STATUS_REFRESH_MS,
  STATUS_TTL_SECONDS,
  STREAM_MAX_MS,
  WATCH_POLL_MS,
  appLogChannel,
  appLogWatchKey,
  appStatusKey,
  deploymentJobDataSchema,
  isSupervisable,
  stripAnsi,
  type AppLogMessage,
  type AppStatus,
} from '@pupitre/core';
import { getDriver } from '@pupitre/core/drivers';
import type {
  DeploymentDriver,
  DriverContext,
  LogSink,
} from '@pupitre/core/drivers';
import { disconnect } from '@pupitre/core/ssh';
import {
  getDeploymentSummary,
  logAudit,
  recordHealthStatus,
  setDeploymentStopped,
} from '@pupitre/db';
import type { Job } from 'bullmq';
import { openDeploymentContext } from '../deploy/context.js';
import { instanceLanguage } from '../language.js';
import { logger } from '../logger.js';
import { workerSay } from '../messages.js';
import { getPublisher, getRedis } from '../redis.js';

/**
 * Monitoring of running applications.
 *
 * Following logs is the only work in the project that has **no natural end**. It
 * therefore cannot stop by itself like the others: it is a viewer's presence
 * that keeps it alive. The SSE route refreshes a short-lived Redis key as long as
 * a client listens; this job reads it regularly and cuts the SSH session as soon
 * as it has disappeared.
 *
 * This mechanism covers the four cases that matter:
 *   - tab closed cleanly      → the route stops refreshing, the key expires;
 *   - tab killed abruptly     → nobody refreshes, the key expires;
 *   - several viewers         → all refresh the same key;
 *   - worker restarted        → the job dies, the panel asks for another one.
 *
 * A duration cap completes the mechanism: a worker slot must not stay taken
 * because a tab stayed open a whole weekend.
 */

/**
 * Isolates the service's name from a prefixed line.
 *
 * The returned name must be the one `status()` reports, otherwise the
 * interface's per-service filter would never find anything. But the two runtimes
 * decorate the prefix differently:
 *
 *   Compose  `api-1  | message`            — container name: service + index
 *   kubectl  `[pod/app-demo-api-7d9f/api] message` — last segment: container,
 *                                             which our manifests name after
 *                                             the service
 */
function splitPrefix(raw: string): { service: string | null; line: string } {
  const kube = /^\[pod\/[^\]/]+\/([^\]/]+)]\s?([\s\S]*)$/.exec(raw);
  if (kube?.[1]) return { service: kube[1], line: kube[2] ?? '' };

  const separator = raw.indexOf('|');
  if (separator <= 0 || separator > 60) return { service: null, line: raw };

  const candidate = raw.slice(0, separator).trim();
  // A log prefix is an identifier, not a sentence.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(candidate)) return { service: null, line: raw };

  // Compose always adds exactly one replica index: we remove only one, which stays
  // right even for a service whose name ends with a digit (`web-2` gives the
  // `web-2-1` container).
  return {
    service: candidate.replace(/-\d+$/, ''),
    line: raw.slice(separator + 1).replace(/^ /, ''),
  };
}

export async function handleAppLogs(job: Job<unknown>): Promise<{ lines: number }> {
  const data = deploymentJobDataSchema.parse(job.data);
  const log = logger.child({ jobId: job.id, deploymentId: data.deploymentId });

  const summary = await getDeploymentSummary(data.deploymentId);
  if (!summary) {
    throw new Error(
      workerSay(await instanceLanguage())('notFound.deployment', { id: data.deploymentId }),
    );
  }
  if (!isSupervisable(summary.status)) {
    log.info({ status: summary.status }, 'deployment not monitorable, stream not opened');
    return { lines: 0 };
  }

  const channel = appLogChannel(data.deploymentId);
  const watchKey = appLogWatchKey(data.deploymentId);
  const publisher = getPublisher();
  const redis = getRedis();

  // Nobody is listening anymore: no need to open an SSH session.
  if ((await redis.exists(watchKey)) === 0) {
    log.info('no viewer, stream not opened');
    return { lines: 0 };
  }

  const emit = (message: AppLogMessage) => {
    publisher.publish(channel, JSON.stringify(message)).catch((error: unknown) => {
      log.warn({ err: error }, 'application stream could not be published');
    });
  };

  const { session, ctx, deployment } = await openDeploymentContext(data.deploymentId);
  const driver = getDriver(deployment.runtime);

  let lines = 0;
  let stop = false;
  let watcher: NodeJS.Timeout | null = null;
  let ceiling: NodeJS.Timeout | null = null;
  let refresher: NodeJS.Timeout | null = null;

  /**
   * Publishes a reading **and keeps it**.
   *
   * Publishing is not enough: Redis does not replay a `publish`, and the stream is
   * shared between all the viewers of a deployment. The second tab therefore
   * arrives after the broadcast and would never have a state — it is what made
   * "no container reported" show next to perfectly alive logs. The kept key is
   * what the SSE route serves to the newcomer.
   */
  const publishStatus = async (status: AppStatus): Promise<void> => {
    emit({ kind: 'status', payload: status });
    try {
      await redis.set(
        appStatusKey(data.deploymentId),
        JSON.stringify(status),
        'EX',
        STATUS_TTL_SECONDS,
      );
    } catch (error) {
      // The stream does not stop because the state cache failed.
      log.warn({ err: error }, 'last state could not be stored');
    }
  };

  try {
    emit({
      kind: 'lifecycle',
      payload: { ts: new Date().toISOString(), action: 'stream.started', detail: null },
    });

    // A state snapshot before the logs: the viewer sees right away what runs,
    // without waiting for a line to be produced.
    const status: AppStatus = await driver.status(ctx);
    await publishStatus(status);

    /**
     * Cutting the SSH session is what ends `logs -f`: the remote command receives an
     * EOF and returns. It is safer than counting on a signal, which does not always
     * go through the channel.
     */
    const halt = (reason: string) => {
      if (stop) return;
      stop = true;
      log.info({ reason, lines }, 'application stream interrupted');
      void disconnect(session);
    };

    watcher = setInterval(() => {
      redis
        .exists(watchKey)
        .then((present) => {
          if (present === 0) halt('no viewer left');
        })
        .catch((error: unknown) => {
          log.warn({ err: error }, 'presence key could not be read');
        });
    }, WATCH_POLL_MS);

    ceiling = setTimeout(() => halt('maximum duration reached'), STREAM_MAX_MS);

    /**
     * Periodic re-reading, on the SSH session already open.
     *
     * Without it, the state card is frozen on the opening snapshot for the stream's
     * whole life — up to thirty minutes. A container that exits or restarts in a
     * loop would read in the logs without ever appearing in the inventory, which is
     * precisely the contradiction being fixed.
     *
     * One reading at a time: `pending` avoids stacking `compose ps` if the machine
     * takes more than twenty seconds to answer.
     */
    let pending = false;
    refresher = setInterval(() => {
      if (stop || pending) return;
      pending = true;
      driver
        .status(ctx)
        .then((fresh) => publishStatus(fresh))
        .catch((error: unknown) => {
          // The session may be being cut: it is no reason to interrupt the log stream,
          // which is still alive.
          if (!stop) log.warn({ err: error }, 'state reading failed');
        })
        .finally(() => {
          pending = false;
        });
    }, STATUS_REFRESH_MS);

    await driver.logs(ctx, (raw) => {
      if (stop) return;
      const cleaned = stripAnsi(raw).replace(/\r$/, '');
      if (cleaned.trim().length === 0) return;

      lines += 1;
      const { service, line } = splitPrefix(cleaned);
      emit({
        kind: 'log',
        payload: { ts: new Date().toISOString(), service, line },
      });
    });

    return { lines };
  } finally {
    if (watcher) clearInterval(watcher);
    if (ceiling) clearTimeout(ceiling);
    if (refresher) clearInterval(refresher);

    emit({
      kind: 'lifecycle',
      payload: {
        ts: new Date().toISOString(),
        action: 'stream.stopped',
        detail: `${lines} line(s)`,
      },
    });

    await disconnect(session);
  }
}

/**
 * Restarting a running application.
 *
 * It is neither a deployment nor a rollback: same images, same volumes, same
 * port. The deployment's status is not changed — only its health is, and it is
 * probed again right after.
 */
export async function handleAppRestart(job: Job<unknown>): Promise<{ healthy: boolean }> {
  const data = deploymentJobDataSchema.parse(job.data);
  const log = logger.child({ jobId: job.id, deploymentId: data.deploymentId });

  const summary = await getDeploymentSummary(data.deploymentId);
  if (!summary) {
    throw new Error(
      workerSay(await instanceLanguage())('notFound.deployment', { id: data.deploymentId }),
    );
  }
  if (!isSupervisable(summary.status)) {
    throw new Error(
      workerSay(await instanceLanguage())('lifecycle.notRestartable', { status: summary.status }),
    );
  }

  const channel = appLogChannel(data.deploymentId);
  const publisher = getPublisher();
  const emit = (message: AppLogMessage) => {
    publisher.publish(channel, JSON.stringify(message)).catch(() => {
      // The restart must not fail because nobody is watching.
    });
  };

  const { session, ctx, deployment } = await openDeploymentContext(data.deploymentId);
  const driver = getDriver(deployment.runtime);

  try {
    const say = workerSay(ctx.language);
    emit({
      kind: 'lifecycle',
      payload: {
        ts: new Date().toISOString(),
        action: 'restart',
        detail: say('lifecycle.started'),
      },
    });

    await driver.restart(ctx, (line) => {
      emit({ kind: 'log', payload: { ts: new Date().toISOString(), service: null, line } });
    });

    const health = await driver.healthcheck(ctx);
    emit({ kind: 'status', payload: await driver.status(ctx) });
    emit({
      kind: 'lifecycle',
      payload: {
        ts: new Date().toISOString(),
        action: 'restart',
        detail: health.healthy
          ? say('lifecycle.healthy')
          : say('lifecycle.outcome', { outcome: say(`outcome.${health.outcome}`) }),
        done: true,
      },
    });

    // The deployment's status does not move: a restart is not a new deployment. Only
    // the observed health is updated.
    await recordHealthStatus(
      data.deploymentId,
      health.healthy ? 'healthy' : health.outcome === 'unreachable' ? 'unreachable' : 'unhealthy',
    );

    await logAudit({
      actorId: data.actorId,
      action: 'app.restarted',
      resourceType: 'deployment',
      resourceId: data.deploymentId,
      after: {
        applicationSlug: summary.applicationSlug,
        targetName: summary.targetName,
        healthy: health.healthy,
      },
      ip: data.ip,
    });

    log.info({ healthy: health.healthy }, 'application restarted');
    return { healthy: health.healthy };
  } finally {
    await disconnect(session);
  }
}

/**
 * Stopping and starting a deployed application.
 *
 * The two gestures share everything except three things: the driver method to
 * call, what is written in `stopped_at`, and the activity log's word. Hence a
 * single parameterized implementation — duplicating would have guaranteed that
 * one day one of the two forgets to republish the state or to close its SSH
 * session.
 *
 * It is **not** a branch on the runtime: `stop()` and `start()` are part of the
 * contract, and it is the driver returned by the factory that knows what they
 * mean on its machine. The worker does not know whether it talks to Compose or
 * Kubernetes, and does not have to.
 */
type LifecycleAction = {
  /** The action's name in the application stream and in the activity log. */
  key: 'stop' | 'start';
  apply: (driver: DeploymentDriver, ctx: DriverContext, onLog: LogSink) => Promise<void>;
  auditAction: string;
};

const STOP: LifecycleAction = {
  key: 'stop',
  apply: (driver, ctx, onLog) => driver.stop(ctx, onLog),
  auditAction: 'app.stopped',
};

const START: LifecycleAction = {
  key: 'start',
  apply: (driver, ctx, onLog) => driver.start(ctx, onLog),
  auditAction: 'app.started',
};

async function runLifecycle(
  job: Job<unknown>,
  action: LifecycleAction,
): Promise<{ stopped: boolean; healthy: boolean | null }> {
  const data = deploymentJobDataSchema.parse(job.data);
  const log = logger.child({ jobId: job.id, deploymentId: data.deploymentId });

  const summary = await getDeploymentSummary(data.deploymentId);
  if (!summary) {
    throw new Error(
      workerSay(await instanceLanguage())('notFound.deployment', { id: data.deploymentId }),
    );
  }
  if (!isSupervisable(summary.status)) {
    throw new Error(
      workerSay(await instanceLanguage())(`lifecycle.refused.${action.key}`, {
        status: summary.status,
      }),
    );
  }

  const channel = appLogChannel(data.deploymentId);
  const publisher = getPublisher();
  const emit = (message: AppLogMessage) => {
    publisher.publish(channel, JSON.stringify(message)).catch(() => {
      // The gesture must not fail because nobody is watching.
    });
  };

  const { session, ctx, deployment } = await openDeploymentContext(data.deploymentId);
  const driver = getDriver(deployment.runtime);

  try {
    const say = workerSay(ctx.language);
    emit({
      kind: 'lifecycle',
      payload: {
        ts: new Date().toISOString(),
        action: action.key,
        detail: say('lifecycle.started'),
      },
    });

    await action.apply(driver, ctx, (line) => {
      emit({ kind: 'log', payload: { ts: new Date().toISOString(), service: null, line } });
    });

    // The database is only written **after** the gesture. A stop that fails halfway
    // leaves the row unchanged: better a database that believes the application
    // running while it only half is — the screen shows the machine's real state —
    // than a database that declares it stopped while it still serves traffic.
    await setDeploymentStopped(data.deploymentId, action.key === 'stop' ? new Date() : null);

    /**
     * We only probe health again at start. After a stop, the healthcheck would fail
     * by construction: it would write `unreachable`, that is an outage, where there
     * is only a decision. `setDeploymentStopped()` already set health back to
     * `unknown`, which is the only true thing.
     */
    let healthy: boolean | null = null;
    if (action.key === 'start') {
      const health = await driver.healthcheck(ctx);
      healthy = health.healthy;
      await recordHealthStatus(
        data.deploymentId,
        health.healthy
          ? 'healthy'
          : health.outcome === 'unreachable'
            ? 'unreachable'
            : 'unhealthy',
      );
    }

    emit({ kind: 'status', payload: await driver.status(ctx) });
    emit({
      kind: 'lifecycle',
      payload: {
        ts: new Date().toISOString(),
        action: action.key,
        detail:
          healthy === null
            ? say('lifecycle.done')
            : healthy
              ? say('lifecycle.healthy')
              : say('lifecycle.unhealthy'),
        done: true,
      },
    });

    await logAudit({
      actorId: data.actorId,
      action: action.auditAction,
      resourceType: 'deployment',
      resourceId: data.deploymentId,
      after: {
        applicationSlug: summary.applicationSlug,
        targetName: summary.targetName,
        runtime: deployment.runtime,
        ...(healthy === null ? {} : { healthy }),
      },
      ip: data.ip,
    });

    log.info({ action: action.key, healthy }, 'application: gesture done');
    return { stopped: action.key === 'stop', healthy };
  } finally {
    await disconnect(session);
  }
}

/** Deliberate stop: the processes stop, nothing is taken down. */
export async function handleAppStop(job: Job<unknown>): Promise<{ stopped: boolean }> {
  const outcome = await runLifecycle(job, STOP);
  return { stopped: outcome.stopped };
}

/** Starting a stopped application again, followed by a health probe. */
export async function handleAppStart(
  job: Job<unknown>,
): Promise<{ stopped: boolean; healthy: boolean | null }> {
  return runLifecycle(job, START);
}
