import {
  WORKLOAD_EXEC_MAX_LINES,
  WORKLOAD_EXEC_TIMEOUT_SEC,
  encodeWorkloadRef,
  workloadActionJobDataSchema,
  workloadChannel,
  workloadControlJobDataSchema,
  workloadExecJobDataSchema,
  workloadListJobDataSchema,
  workloadLogsJobDataSchema,
  type Workload,
  type WorkloadActionJobData,
  type WorkloadActionJobResult,
  type WorkloadListJobResult,
  type WorkloadMessage,
} from '@pupitre/core';
import { getDriver, type TargetContext } from '@pupitre/core/drivers';
import { disconnect } from '@pupitre/core/ssh';
import { logAudit } from '@pupitre/db';
import type { Job } from 'bullmq';
import { openTargetContext } from '../deploy/target-context.js';
import { logger } from '../logger.js';
import { getPublisher } from '../redis.js';

/**
 * A target machine's workloads: inventory, deletion, update, life cycle, log,
 * commands.
 *
 * Seven jobs, a single file, because they share everything: opening the SSH
 * session, choosing the driver, and above all the fact that none knows what a
 * container is. The worker asks the runtime's driver, the driver answers; there
 * is no branch on `docker` or `k3s` anywhere here.
 */

/**
 * The target's workload inventory, all runtimes together.
 *
 * A target can announce Docker **and** K3s: we then query both and concatenate.
 * Each workload carries its runtime, which is enough to send it back later to
 * the right driver — the panel never has to decide.
 *
 * The result travels through the BullMQ return value, not through the database:
 * an inventory is true at the second it is taken and stale right after. Storing
 * it would require a table, a migration, and a freshness policy for data that
 * has no history.
 */
export async function handleWorkloadList(
  job: Job<unknown, WorkloadListJobResult>,
): Promise<WorkloadListJobResult> {
  const data = workloadListJobDataSchema.parse(job.data);
  const log = logger.child({ jobId: job.id, jobName: job.name, targetId: data.targetId });

  const opened = await openTargetContext(data.targetId);
  const items: Workload[] = [];
  const runtimes: WorkloadListJobResult['runtimes'] = [];

  try {
    for (const runtime of opened.runtimes) {
      try {
        const found = await getDriver(runtime).listWorkloads(opened.ctx);
        items.push(...found);
        runtimes.push({ runtime, ok: true, error: null, count: found.length });
      } catch (error) {
        // A silent runtime must not take the other down: a target running Docker and a
        // broken K3s still has containers to show.
        const message = error instanceof Error ? error.message : String(error);
        log.warn({ runtime, err: error }, 'inventory failed for this runtime');
        runtimes.push({ runtime, ok: false, error: message, count: 0 });
      }
    }

    log.info(
      { count: items.length, managed: items.filter((item) => item.managed).length },
      'workloads inventory completed',
    );

    return {
      targetId: data.targetId,
      checkedAt: new Date().toISOString(),
      items,
      runtimes,
    };
  } finally {
    await disconnect(opened.session);
  }
}

/**
 * The common envelope of the gestures on a workload: the session, the real-time
 * stream, the audit log. Each gesture only provides its verb on the driver, and
 * the name of its audit lines.
 */
type Outcome = { exitCode: number | null; timedOut?: boolean; truncated?: boolean };

type Operation = {
  /** What the driver does. Returns a command's exit code, nothing otherwise. */
  run: (
    driver: ReturnType<typeof getDriver>,
    ctx: TargetContext,
    onLog: (line: string) => void,
  ) => Promise<Outcome>;
  audit: { ok: string; failed: string } | null;
  /** What the audit log keeps on top — the command, its code. */
  details?: (outcome: Outcome) => Record<string, unknown>;
};

async function runWorkloadOperation(
  job: Job,
  data: WorkloadActionJobData & { run?: string },
  operation: Operation,
): Promise<WorkloadActionJobResult> {
  const encoded = encodeWorkloadRef(data.ref);
  const log = logger.child({
    jobId: job.id,
    jobName: job.name,
    targetId: data.targetId,
    ref: encoded,
  });

  const channel = workloadChannel(data.targetId);
  const publisher = getPublisher();
  const emit = (message: WorkloadMessage) => {
    publisher.publish(channel, JSON.stringify(message)).catch((error: unknown) => {
      // The operation must not fail because nobody is watching.
      log.warn({ err: error }, 'progress could not be published');
    });
  };
  const lifecycle = (
    status: 'started' | 'succeeded' | 'failed',
    detail: string | null,
    outcome?: Outcome,
  ) =>
    emit({
      kind: 'lifecycle',
      payload: {
        ts: new Date().toISOString(),
        ref: encoded,
        name: data.name,
        action: data.action,
        status,
        detail,
        ...(data.run ? { run: data.run } : {}),
        ...(outcome ?? {}),
      },
    });

  let lines = 0;
  const onLog = (line: string) => {
    lines += 1;
    emit({
      kind: 'log',
      payload: {
        ts: new Date().toISOString(),
        ref: encoded,
        line,
        ...(data.run ? { run: data.run } : {}),
      },
    });
  };

  lifecycle('started', null);
  const opened = await openTargetContext(data.targetId);
  const driver = getDriver(data.ref.runtime);
  const context = {
    workload: data.name,
    ref: encoded,
    runtime: data.ref.runtime,
    targetName: opened.name,
    targetHost: opened.ctx.target.host,
  };

  try {
    const outcome = await operation.run(driver, opened.ctx, onLog);
    lifecycle('succeeded', null, outcome);
    if (operation.audit) {
      await logAudit({
        actorId: data.actorId,
        action: operation.audit.ok,
        resourceType: 'target',
        resourceId: data.targetId,
        after: { ...context, ...(operation.details?.(outcome) ?? {}) },
        ip: data.ip,
      });
    }
    log.info({ action: data.action, lines }, 'workload action completed');
    return {
      targetId: data.targetId,
      ref: encoded,
      action: data.action,
      ok: true,
      lines,
      exitCode: outcome.exitCode,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    lifecycle('failed', detail);
    // A refusal from the driver — panel workload, system namespace, options that
    // cannot be reproduced — is a decision, not an incident: it is recorded like
    // success, otherwise the log only tells half the story.
    if (operation.audit) {
      await logAudit({
        actorId: data.actorId,
        action: operation.audit.failed,
        resourceType: 'target',
        resourceId: data.targetId,
        after: { ...context, ...(operation.details?.({ exitCode: null }) ?? {}), error: detail },
        ip: data.ip,
      });
    }
    throw error;
  } finally {
    await disconnect(opened.session);
  }
}

/** Deleting or updating a workload. */
export async function handleWorkloadAction(
  job: Job<unknown, WorkloadActionJobResult>,
): Promise<WorkloadActionJobResult> {
  const data = workloadActionJobDataSchema.parse(job.data);
  const remove = data.action === 'remove';
  return runWorkloadOperation(job, data, {
    run: async (driver, ctx, onLog) => {
      if (remove) await driver.removeWorkload(ctx, data.ref, onLog);
      else await driver.updateWorkload(ctx, data.ref, onLog);
      return { exitCode: null };
    },
    audit: remove
      ? { ok: 'workload.removed', failed: 'workload.remove.failed' }
      : { ok: 'workload.updated', failed: 'workload.update.failed' },
  });
}

const CONTROL_AUDIT = {
  start: { ok: 'workload.started', failed: 'workload.start.failed' },
  stop: { ok: 'workload.stopped', failed: 'workload.stop.failed' },
  restart: { ok: 'workload.restarted', failed: 'workload.restart.failed' },
} as const;

/** Starting, stopping, restarting a workload. */
export async function handleWorkloadControl(
  job: Job<unknown, WorkloadActionJobResult>,
): Promise<WorkloadActionJobResult> {
  const data = workloadControlJobDataSchema.parse(job.data);
  return runWorkloadOperation(job, data, {
    run: async (driver, ctx, onLog) => {
      await driver.controlWorkload(ctx, data.ref, data.action, onLog);
      return { exitCode: null };
    },
    audit: CONTROL_AUDIT[data.action],
  });
}

/**
 * A workload's last log lines, to the screen that asked for them — through the
 * real-time channel, never through the database or the job's return value: a
 * log can carry secrets, it is not stored. Reading is recorded: reading a
 * container's log is seeing what it writes.
 */
export async function handleWorkloadLogs(
  job: Job<unknown, WorkloadActionJobResult>,
): Promise<WorkloadActionJobResult> {
  const data = workloadLogsJobDataSchema.parse(job.data);
  return runWorkloadOperation(job, data, {
    run: async (driver, ctx, onLog) => {
      await driver.workloadLogs(ctx, data.ref, data.tail, onLog);
      return { exitCode: null };
    },
    audit: { ok: 'workload.logs.read', failed: 'workload.logs.failed' },
    details: () => ({ tail: data.tail }),
  });
}

/**
 * A command in a workload. The audit log keeps the command and its exit code —
 * it is the price of such a powerful gesture —, never its output, which only
 * goes to the screen.
 */
export async function handleWorkloadExec(
  job: Job<unknown, WorkloadActionJobResult>,
): Promise<WorkloadActionJobResult> {
  const data = workloadExecJobDataSchema.parse(job.data);
  return runWorkloadOperation(job, data, {
    run: async (driver, ctx, onLog) => {
      const result = await driver.execInWorkload(ctx, data.ref, data.command, onLog, {
        timeoutMs: WORKLOAD_EXEC_TIMEOUT_SEC * 1000,
        maxLines: WORKLOAD_EXEC_MAX_LINES,
      });
      return {
        exitCode: result.timedOut ? null : result.exitCode,
        timedOut: result.timedOut,
        truncated: result.truncated,
      };
    },
    audit: { ok: 'workload.exec', failed: 'workload.exec.failed' },
    details: (outcome) => ({
      command: data.command,
      exitCode: outcome.exitCode,
      ...(outcome.timedOut ? { timedOut: true } : {}),
    }),
  });
}
