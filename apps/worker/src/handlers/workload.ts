import {
  WORKLOAD_EXEC_MAX_LINES,
  WORKLOAD_EXEC_TIMEOUT_SEC,
  decrypt,
  encodeWorkloadRef,
  usableRuntimes,
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
import { connect, disconnect, type SshSession, type SshTarget } from '@pupitre/core/ssh';
import { getTargetSecret, logAudit } from '@pupitre/db';
import type { Job } from 'bullmq';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { getPublisher } from '../redis.js';

/**
 * Charges d'une machine cible : inventaire, suppression, mise à jour, cycle
 * de vie, journal, commandes.
 *
 * Sept tâches, un seul fichier, parce qu'elles partagent tout : l'ouverture de
 * la session SSH, le choix du driver, et surtout le fait qu'aucune ne sait ce
 * qu'est un conteneur. Le worker demande au driver du runtime, le driver
 * répond ; il n'y a nulle part ici de branche sur `docker` ou `k3s`.
 */

type OpenedTarget = {
  session: SshSession;
  ctx: TargetContext;
  runtimes: Array<'docker' | 'k3s'>;
  name: string;
};

/**
 * Ouvre une session SSH vers une cible, sans aucun déploiement en tête.
 *
 * Pendant de `openDeploymentContext()`, pour le contexte de cible. Comme lui,
 * c'est un des rares endroits où un credential est déchiffré, et il ne quitte
 * pas la portée de cette fonction.
 */
async function openTargetContext(targetId: string): Promise<OpenedTarget> {
  const record = await getTargetSecret(targetId);
  if (!record) throw new Error(`Cible « ${targetId} » introuvable`);

  const { target, encryptedCredential } = record;
  const secret = decrypt(encryptedCredential);

  const sshTarget: SshTarget = {
    host: target.host,
    port: target.port,
    username: target.sshUser,
    sudoMethod: target.sudoMethod,
    credentials:
      target.authMethod === 'key'
        ? { authMethod: 'key', privateKey: secret }
        : { authMethod: 'password', password: secret },
  };

  const session = await connect(sshTarget, { logger });

  return {
    session,
    name: target.name,
    runtimes: usableRuntimes(target.runtimesAvailable),
    ctx: {
      target: {
        id: target.id,
        name: target.name,
        host: target.host,
        rootPath: env.DRIVER_ROOT_PATH,
      },
      sshSession: session,
    },
  };
}

/**
 * Inventaire des charges de la cible, tous runtimes confondus.
 *
 * Une cible peut annoncer Docker **et** K3s : on interroge alors les deux et on
 * concatène. Chaque charge porte son runtime, ce qui suffit à la renvoyer plus
 * tard au bon driver — le panel n'a jamais à en décider.
 *
 * Le résultat voyage par la valeur de retour BullMQ, pas par la base : un
 * inventaire est vrai à la seconde où il est pris et périmé juste après. Le
 * stocker demanderait une table, une migration, et une politique de fraîcheur
 * pour une donnée qui n'a pas d'histoire.
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
        // Un runtime muet ne doit pas emporter l'autre : une cible qui fait
        // tourner Docker et un K3s cassé a quand même des conteneurs à montrer.
        const message = error instanceof Error ? error.message : String(error);
        log.warn({ runtime, err: error }, 'inventaire impossible pour ce runtime');
        runtimes.push({ runtime, ok: false, error: message, count: 0 });
      }
    }

    log.info(
      { count: items.length, managed: items.filter((item) => item.managed).length },
      'inventaire des charges terminé',
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
 * L'enveloppe commune des gestes sur une charge : la session, le flux temps
 * réel, le journal d'audit. Chaque geste ne fournit que son verbe sur le
 * driver, et le nom de ses lignes d'audit.
 */
type Outcome = { exitCode: number | null; timedOut?: boolean; truncated?: boolean };

type Operation = {
  /** Ce que le driver fait. Rend le code de sortie d'une commande, rien sinon. */
  run: (
    driver: ReturnType<typeof getDriver>,
    ctx: TargetContext,
    onLog: (line: string) => void,
  ) => Promise<Outcome>;
  audit: { ok: string; failed: string } | null;
  /** Ce que le journal d'audit retient en plus — la commande, son code. */
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
      // L'opération ne doit pas échouer parce que personne ne regarde.
      log.warn({ err: error }, 'publication de la progression impossible');
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
    log.info({ action: data.action, lines }, 'action sur charge terminée');
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
    // Un refus du driver — charge du panel, namespace système, options non
    // reproductibles — est une décision, pas un incident : il se trace comme le
    // succès, sinon le journal ne raconte qu'une moitié de l'histoire.
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

/** Suppression ou mise à jour d'une charge. */
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

/** Démarrer, arrêter, redémarrer une charge. */
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
 * Les dernières lignes du journal d'une charge, vers l'écran qui les a
 * demandées — par le canal temps réel, jamais par la base ni par la valeur de
 * retour de la tâche : un journal peut porter des secrets, il ne se stocke pas.
 * La lecture est tracée : lire le journal d'un conteneur, c'est voir ce qu'il
 * écrit.
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
 * Une commande dans une charge. Le journal d'audit garde la commande et son
 * code de sortie — c'est le prix d'un geste aussi puissant —, jamais sa
 * sortie, qui ne va qu'à l'écran.
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
