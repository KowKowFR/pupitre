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
 * Les quatre tâches planifiées.
 *
 * Règle commune, et non négociable : **aucune n'agit**. Elles constatent,
 * enregistrent et alertent. Un scan périodique qui remonte une CRITICAL ne
 * bloque rien et ne redéploie rien ; un healthcheck qui échoue ne déclenche
 * aucun rollback. Toute action destructrice automatique est hors périmètre —
 * hormis la purge des répertoires de version, qui est explicitement demandée et
 * qui ne touche jamais la version courante.
 *
 * Aucun `if (runtime === …)` ici : chaque tâche demande son driver à la
 * fabrique et lui parle par l'interface.
 */

export type RunnerContext = {
  payload: Record<string, unknown>;
  onLog: (line: string) => void;
  /** Ce que la tâche écrit à son journal, dans la langue de l'instance. */
  say: WorkerSay;
};

export type RunnerSummary = Record<string, unknown>;

export type ScheduledJobRunner = (ctx: RunnerContext) => Promise<RunnerSummary>;

/** Restreint le champ d'action d'une tâche. Absent = toutes les applications. */
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
 * Ouvre le contexte, exécute, referme — toujours. Une session SSH laissée
 * ouverte par une tâche qui tourne toutes les cinq minutes finit par épuiser
 * `MaxStartups` sur la cible.
 */
async function forEachCurrentDeployment<T>(
  payload: Record<string, unknown>,
  onLog: (line: string) => void,
  action: (deployment: Deployment, opened: Awaited<ReturnType<typeof openDeploymentContext>>) => Promise<T>,
  /**
   * Écarte un déploiement **avant** d'ouvrir sa session SSH, en disant
   * pourquoi. Le filtre est ici et non dans l'action parce que la session est
   * justement ce qu'on veut éviter de payer : une tâche qui tourne toutes les
   * cinq minutes n'a pas à se connecter à une machine pour rien.
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
      logger.warn({ err: error, deploymentId: deployment.id }, 'tâche planifiée en échec');
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
      // Une application déployée sans scanner n'en veut pas : on ne lui en
      // impose pas depuis une tâche de fond.
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
      // On EMPILE : l'intérêt d'un scan périodique est de comparer dans le temps
      // un déploiement qui, lui, n'a pas bougé.
      clearPrevious: false,
    });

    scanned += 1;
    findings += Object.values(result.counts).reduce((sum, value) => sum + value, 0);

    if (result.blocked) {
      alerting += 1;
      // Alerte, et rien d'autre. Le déploiement reste en place.
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

      // Aucun rollback. Le statut informe l'opérateur ; c'est lui qui décide.
      return { deploymentId: deployment.id, outcome: health.outcome, attempts: health.attempts };
    },
    /**
     * Une application volontairement arrêtée n'est pas une application en
     * panne. La sonder rapporterait `unreachable` à chaque passage, peindrait
     * le tableau de bord en rouge et — le jour où une alerte s'y branchera —
     * réveillerait quelqu'un pour une décision qu'il a prise lui-même. Son
     * arrêt a déjà remis sa santé à `unknown` : c'est la seule chose vraie, et
     * on n'y touche pas.
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
    // Le driver sait où il dépose ses releases. La tâche ne nomme aucun chemin,
    // et ne sait pas sur quel runtime elle tourne.
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
    // On réutilise la tâche de preflight plutôt que d'en dupliquer la logique :
    // une seule implémentation du preflight, un seul endroit où un credential
    // est déchiffré.
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
 * Enfile une sauvegarde par application dont la sauvegarde automatique est
 * activée, et par cible où elle tourne. La tâche planifiée rend la main tout de
 * suite : les sauvegardes, elles, se suivent sur la file `backups`, une à la
 * fois, et chacune a sa ligne et son verdict.
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
 * Une entrée par type. Ajouter une tâche planifiée = une entrée ici et une dans
 * `SCHEDULED_JOB_TYPES` ; aucun `switch` nulle part.
 */
export const SCHEDULED_JOB_RUNNERS: Record<ScheduledJobType, ScheduledJobRunner> = {
  scan: runScanPeriodic,
  healthcheck: runHealthPeriodic,
  cleanup: runCleanupVersions,
  preflight: runTargetPreflight,
  backup: runBackupApplications,
  panel_backup: runBackupPanel,
};
