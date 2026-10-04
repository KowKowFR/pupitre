import {
  BACKUP_APPLICATION_JOB,
  BACKUP_PANEL_JOB,
  errorMessage,
  failOnSchema,
  parseScanConfig,
  scannerKeySchema,
  TARGET_PREFLIGHT_JOB,
  type ScanConfig,
  type ScheduledJobType,
} from '@pupitre/core';
import { getDriver } from '@pupitre/core/drivers';
import { disconnect } from '@pupitre/core/ssh';
import {
  listCurrentDeployments,
  listLiveDeployments,
  listScheduledBackupPolicies,
  listTargets,
  recordHealthStatus,
  type Deployment,
} from '@pupitre/db';
import { z } from 'zod';
import { openDeploymentContext } from '../deploy/context.js';
import { runSecurityScan } from '../deploy/scan.js';
import { logger } from '../logger.js';
import type { WorkerSay } from '../messages.js';
import { getBackupsQueue, getOpsQueue } from '../queue.js';

/**
 * The four scheduled tasks.
 *
 * A common, non-negotiable rule: **none acts**. They observe, record and alert.
 * A periodic scan that finds a CRITICAL blocks nothing and redeploys nothing; a
 * failing healthcheck triggers no rollback. Any automatic destructive action is
 * out of scope — except purging the version directories, which is explicitly
 * requested and never touches the current version.
 *
 * No `if (runtime === …)` here: each task asks the factory for its driver and
 * talks to it through the interface.
 */

export type RunnerContext = {
  payload: Record<string, unknown>;
  onLog: (line: string) => void;
  /** What the task writes to its log, in the instance's language. */
  say: WorkerSay;
};

export type RunnerSummary = Record<string, unknown>;

export type ScheduledJobRunner = (ctx: RunnerContext) => Promise<RunnerSummary>;

/** Restricts a task's scope. Absent = every application. */
const scopeSchema = z.object({
  applicationIds: z.array(z.string().uuid()).optional(),
  targetIds: z.array(z.string().uuid()).optional(),
});

function inScope(deployment: Deployment, payload: Record<string, unknown>): boolean {
  const scope = scopeSchema.safeParse(payload);
  if (!scope.success) return true;
  const { applicationIds, targetIds } = scope.data;
  if (applicationIds && !applicationIds.includes(deployment.applicationId)) return false;
  if (targetIds && !targetIds.includes(deployment.targetId)) return false;
  return true;
}

/**
 * Opens the context, runs, closes — always. An SSH session left open by a task
 * running every five minutes ends up exhausting `MaxStartups` on the target.
 */
async function forEachCurrentDeployment<T>(
  payload: Record<string, unknown>,
  onLog: (line: string) => void,
  action: (deployment: Deployment, opened: Awaited<ReturnType<typeof openDeploymentContext>>) => Promise<T>,
  /**
   * Discards a deployment **before** opening its SSH session, saying why. The
   * filter is here and not in the action because the session is precisely what we
   * want to avoid paying for: a task running every five minutes has no business
   * connecting to a machine for nothing.
   */
  skipWhen?: (deployment: Deployment) => string | null,
): Promise<{ results: T[]; skipped: number; failures: Array<{ deploymentId: string; error: string }> }> {
  const deployments = (await listCurrentDeployments()).filter((deployment) =>
    inScope(deployment, payload),
  );

  const results: T[] = [];
  const failures: Array<{ deploymentId: string; error: string }> = [];
  let skipped = 0;

  for (const deployment of deployments) {
    if (!deployment.appSpec) {
      skipped += 1;
      continue;
    }

    const reason = skipWhen?.(deployment) ?? null;
    if (reason !== null) {
      skipped += 1;
      onLog(`${deployment.id.slice(0, 8)} — ${reason}`);
      continue;
    }

    let opened: Awaited<ReturnType<typeof openDeploymentContext>> | null = null;
    try {
      opened = await openDeploymentContext(deployment.id);
      results.push(await action(deployment, opened));
    } catch (error) {
      const message = errorMessage(error);
      failures.push({ deploymentId: deployment.id, error: message });
      onLog(`✗ ${deployment.id} : ${message}`);
      logger.warn({ err: error, deploymentId: deployment.id }, 'scheduled task failed');
    } finally {
      if (opened) await disconnect(opened.session).catch(() => {});
    }
  }

  return { results, skipped, failures };
}

// ─── scan:periodic ───────────────────────────────────────────────────────────

const scanPayloadSchema = scopeSchema.extend({
  scanners: z.array(scannerKeySchema).optional(),
  failOn: failOnSchema.optional(),
});

const runScanPeriodic: ScheduledJobRunner = async ({ payload, onLog, say }) => {
  const overrides = scanPayloadSchema.safeParse(payload);
  const forcedScanners = overrides.success ? overrides.data.scanners : undefined;
  const forcedFailOn = overrides.success ? overrides.data.failOn : undefined;

  let scanned = 0;
  let withoutConfig = 0;
  let findings = 0;
  let alerting = 0;

  const outcome = await forEachCurrentDeployment(payload, onLog, async (deployment, opened) => {
    const stored = parseScanConfig(deployment.scanConfig);
    const config: ScanConfig = {
      scanners: forcedScanners ?? stored.scanners,
      failOn: forcedFailOn ?? stored.failOn,
      onlyFixable: stored.onlyFixable,
    };

    if (config.scanners.length === 0) {
      // An application deployed without a scanner does not want one: we do not impose
      // one from a background task.
      withoutConfig += 1;
      return { deploymentId: deployment.id, skipped: true };
    }

    const driver = getDriver(deployment.runtime);
    const images = await driver.images(opened.ctx);
    if (images.length === 0) {
      withoutConfig += 1;
      return { deploymentId: deployment.id, skipped: true };
    }

    const result = await runSecurityScan({
      deploymentId: deployment.id,
      ctx: opened.ctx,
      config,
      images,
      store: driver.imageStore(opened.ctx),
      onLog: (line) => onLog(`[${deployment.id.slice(0, 8)}] ${line}`),
      // We STACK: the point of a periodic scan is to compare over time a deployment
      // that did not move.
      clearPrevious: false,
    });

    scanned += 1;
    findings += Object.values(result.counts).reduce((sum, value) => sum + value, 0);

    if (result.blocked) {
      alerting += 1;
      // Alert, and nothing else. The deployment stays in place.
      onLog(
        say('schedule.scanAlert', {
          id: deployment.id,
          count: result.blocking.length,
          failOn: config.failOn,
        }),
      );
    }

    return {
      deploymentId: deployment.id,
      images,
      counts: result.counts,
      blocking: result.blocking.length,
    };
  });

  return {
    scanned,
    skipped: withoutConfig + outcome.skipped,
    findings,
    alerting,
    failures: outcome.failures,
    deployments: outcome.results,
  };
};

// ─── health:periodic ─────────────────────────────────────────────────────────

const runHealthPeriodic: ScheduledJobRunner = async ({ payload, onLog, say }) => {
  const byOutcome: Record<string, number> = { healthy: 0, unhealthy: 0, unreachable: 0 };
  let stopped = 0;

  const outcome = await forEachCurrentDeployment(
    payload,
    onLog,
    async (deployment, opened) => {
      const driver = getDriver(deployment.runtime);
      const health = await driver.healthcheck(opened.ctx);

      await recordHealthStatus(deployment.id, health.outcome);
      byOutcome[health.outcome] = (byOutcome[health.outcome] ?? 0) + 1;

      onLog(
        `${deployment.id.slice(0, 8)} — ${say(`outcome.${health.outcome}`)}` +
          (health.detail ? ` (${health.detail})` : ''),
      );

      // No rollback. The status informs the operator; they decide.
      return { deploymentId: deployment.id, outcome: health.outcome, attempts: health.attempts };
    },
    /**
     * A deliberately stopped application is not a failing application. Probing it
     * would report `unreachable` at each pass, paint the dashboard red and — the day
     * an alert is plugged into it — wake someone up for a decision they made
     * themselves. Its stop already set its health back to `unknown`: it is the only
     * true thing, and we leave it alone.
     */
    (deployment) => {
      if (deployment.stoppedAt === null) return null;
      stopped += 1;
      return say('schedule.stoppedNotProbed');
    },
  );

  return {
    probed: outcome.results.length,
    ...byOutcome,
    stopped,
    failures: outcome.failures,
  };
};

// ─── cleanup:versions ────────────────────────────────────────────────────────

const cleanupPayloadSchema = scopeSchema.extend({
  keep: z.number().int().min(1).max(50).optional(),
});

const runCleanupVersions: ScheduledJobRunner = async ({ payload, onLog }) => {
  const parsed = cleanupPayloadSchema.safeParse(payload);
  const keep = parsed.success ? parsed.data.keep : undefined;

  const outcome = await forEachCurrentDeployment(payload, onLog, async (deployment, opened) => {
    const driver = getDriver(deployment.runtime);
    // The driver knows where it places its releases. The task names no path, and
    // does not know which runtime it runs on.
    const removed = await driver.pruneReleases(
      opened.ctx,
      (line) => onLog(`[${deployment.id.slice(0, 8)}] ${line}`),
      keep,
    );
    return { deploymentId: deployment.id, removed };
  });

  const removed = outcome.results.reduce((sum, entry) => sum + entry.removed.length, 0);
  return {
    applications: outcome.results.length,
    removed,
    keep: keep ?? 5,
    failures: outcome.failures,
    detail: outcome.results.filter((entry) => entry.removed.length > 0),
  };
};

// ─── target:preflight:all ────────────────────────────────────────────────────

const runTargetPreflight: ScheduledJobRunner = async ({ payload, onLog, say }) => {
  const scope = scopeSchema.safeParse(payload);
  const wanted = scope.success ? scope.data.targetIds : undefined;

  const targets = (await listTargets()).filter(
    (target) => !wanted || wanted.includes(target.id),
  );

  const queue = getOpsQueue();
  const enqueued: string[] = [];

  for (const target of targets) {
    // We reuse the preflight task rather than duplicate its logic: a single
    // preflight implementation, a single place where a credential is decrypted.
    const job = await queue.add(TARGET_PREFLIGHT_JOB, {
      targetId: target.id,
      actorId: null,
      ip: null,
    });
    enqueued.push(target.name);
    onLog(say('schedule.preflightQueued', { target: target.name, job: job.id ?? '?' }));
  }

  return { targets: targets.length, enqueued };
};

// ─── sauvegardes ─────────────────────────────────────────────────────────────

/**
 * Queues one backup per application whose automatic backup is enabled, and per
 * target where it runs. The scheduled task returns right away: the backups
 * follow one another on the `backups` queue, one at a time, and each has its row
 * and its verdict.
 */
const runBackupApplications: ScheduledJobRunner = async ({ payload, onLog, say }) => {
  const policies = await listScheduledBackupPolicies();
  if (policies.length === 0) {
    onLog(say('schedule.noAutoBackup'));
    return { applications: 0, enqueued: 0 };
  }
  const queue = getBackupsQueue();
  let enqueued = 0;
  for (const { applicationId, slug } of policies) {
    const live = await listLiveDeployments({ applicationId });
    for (const couple of live) {
      if (!couple.inService || !inScope(couple.inService, payload)) continue;
      await queue.add(BACKUP_APPLICATION_JOB, {
        applicationId,
        targetId: couple.targetId,
        trigger: 'schedule',
        backupId: null,
        actorId: null,
        ip: null,
      });
      enqueued += 1;
      onLog(say('schedule.backupQueued', { slug }));
    }
  }
  return { applications: policies.length, enqueued };
};

const runBackupPanel: ScheduledJobRunner = async ({ onLog, say }) => {
  const job = await getBackupsQueue().add(BACKUP_PANEL_JOB, {
    trigger: 'schedule',
    backupId: null,
    actorId: null,
    ip: null,
  });
  onLog(say('schedule.panelBackupQueued', { job: job.id ?? '?' }));
  return { enqueued: 1 };
};

// ─── registre ────────────────────────────────────────────────────────────────

/**
 * One entry per type. Adding a scheduled task = one entry here and one in
 * `SCHEDULED_JOB_TYPES`; no `switch` anywhere.
 */
export const SCHEDULED_JOB_RUNNERS: Record<ScheduledJobType, ScheduledJobRunner> = {
  scan: runScanPeriodic,
  healthcheck: runHealthPeriodic,
  cleanup: runCleanupVersions,
  preflight: runTargetPreflight,
  backup: runBackupApplications,
  panel_backup: runBackupPanel,
};
