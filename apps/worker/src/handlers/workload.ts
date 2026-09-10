import {
  decrypt,
  encodeWorkloadRef,
  usableRuntimes,
  workloadActionJobDataSchema,
  workloadChannel,
  workloadListJobDataSchema,
  type Workload,
  type WorkloadActionJobResult,
  type WorkloadListJobResult,
  type WorkloadMessage,
} from '@tp/core';
import { getDriver, type TargetContext } from '@tp/core/drivers';
import { connect, disconnect, type SshSession, type SshTarget } from '@tp/core/ssh';
import { getTargetSecret, logAudit } from '@tp/db';
import type { Job } from 'bullmq';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { getPublisher } from '../redis.js';

/**
 * Charges d'une machine cible : inventaire, suppression, mise à jour.
 *
 * Trois tâches, un seul fichier, parce qu'elles partagent tout : l'ouverture de
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
 * Suppression ou mise à jour d'une charge.
 *
 * Les deux partagent la même enveloppe : elles désignent la même chose, elles
 * publient au même endroit, elles s'auditent pareil. Seul le verbe appelé sur
 * le driver change, et il est choisi par une table, pas par un `if`.
 */
export async function handleWorkloadAction(
  job: Job<unknown, WorkloadActionJobResult>,
): Promise<WorkloadActionJobResult> {
  const data = workloadActionJobDataSchema.parse(job.data);
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

  let lines = 0;
  const onLog = (line: string) => {
    lines += 1;
    emit({ kind: 'log', payload: { ts: new Date().toISOString(), ref: encoded, line } });
  };

  emit({
    kind: 'lifecycle',
    payload: {
      ts: new Date().toISOString(),
      ref: encoded,
      name: data.name,
      action: data.action,
      status: 'started',
      detail: null,
    },
  });

  const opened = await openTargetContext(data.targetId);
  const driver = getDriver(data.ref.runtime);

  try {
    if (data.action === 'remove') {
      await driver.removeWorkload(opened.ctx, data.ref, onLog);
    } else {
      await driver.updateWorkload(opened.ctx, data.ref, onLog);
    }

    emit({
      kind: 'lifecycle',
      payload: {
        ts: new Date().toISOString(),
        ref: encoded,
        name: data.name,
        action: data.action,
        status: 'succeeded',
        detail: `${lines} ligne(s)`,
      },
    });

    await logAudit({
      actorId: data.actorId,
      action: data.action === 'remove' ? 'workload.removed' : 'workload.updated',
      resourceType: 'target',
      resourceId: data.targetId,
      after: {
        workload: data.name,
        ref: encoded,
        runtime: data.ref.runtime,
        targetName: opened.name,
        targetHost: opened.ctx.target.host,
      },
      ip: data.ip,
    });

    log.info({ action: data.action, lines }, 'action sur charge terminée');
    return { targetId: data.targetId, ref: encoded, action: data.action, ok: true, lines };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    emit({
      kind: 'lifecycle',
      payload: {
        ts: new Date().toISOString(),
        ref: encoded,
        name: data.name,
        action: data.action,
        status: 'failed',
        detail,
      },
    });

    // Un refus du driver — charge du panel, namespace système, options non
    // reproductibles — est une décision, pas un incident : il se trace comme le
    // succès, sinon le journal ne raconte qu'une moitié de l'histoire.
    await logAudit({
      actorId: data.actorId,
      action: data.action === 'remove' ? 'workload.remove.failed' : 'workload.update.failed',
      resourceType: 'target',
      resourceId: data.targetId,
      after: {
        workload: data.name,
        ref: encoded,
        runtime: data.ref.runtime,
        targetName: opened.name,
        error: detail,
      },
      ip: data.ip,
    });

    throw error;
  } finally {
    await disconnect(opened.session);
  }
}
