import {
  decrypt,
  targetMetricsJobDataSchema,
  type TargetMetricsJobResult,
} from '@tp/core';
import { collectHostMetrics, type SshTarget } from '@tp/core/ssh';
import { getTargetSecret } from '@tp/db';
import type { Job } from 'bullmq';
import { env } from '../env.js';
import { logger } from '../logger.js';

/**
 * Relevé des métriques d'une machine cible.
 *
 * Le pendant de `target:preflight`, en plus court : le preflight dit *ce qu'on
 * peut faire* de la machine, le relevé dit *comment elle se porte*. Aucun
 * driver n'est chargé ici — la charge, la mémoire et le disque ne dépendent
 * d'aucun runtime, et c'est exactement pour ça qu'ils vivent à côté du
 * preflight plutôt que dans `DockerComposeDriver` et `K3sDriver`.
 *
 * Le résultat voyage par la valeur de retour BullMQ, jamais par la base : un
 * relevé est vrai à la seconde où il est pris. Le stocker demanderait une
 * table, une migration, et une politique de fraîcheur pour une donnée sans
 * histoire.
 *
 * Aucune écriture d'audit : lire la charge d'une machine qu'on a déjà le droit
 * de voir ne change rien, et un écran qui relève dix serveurs à chaque
 * affichage noierait le journal sous des lignes sans intérêt. Le refus, lui,
 * est bien tracé — par `requirePermission()`, côté panel.
 */
export async function handleTargetMetrics(
  job: Job<unknown, TargetMetricsJobResult>,
): Promise<TargetMetricsJobResult> {
  const data = targetMetricsJobDataSchema.parse(job.data);
  const log = logger.child({ jobId: job.id, jobName: job.name, targetId: data.targetId });

  const record = await getTargetSecret(data.targetId);
  if (!record) throw new Error(`Cible « ${data.targetId} » introuvable`);

  const { target, encryptedCredential } = record;
  // Un des rares endroits où un credential est déchiffré : il ne quitte pas la
  // portée de cette fonction et n'entre dans aucun log.
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

  const metrics = await collectHostMetrics(data.targetId, sshTarget, {
    rootPath: env.DRIVER_ROOT_PATH,
    logger,
  });

  if (metrics.reachable) {
    log.info(
      {
        cores: metrics.load?.cores ?? null,
        load1: metrics.load?.one ?? null,
        memoryUsedPercent: metrics.memory?.usedPercent ?? null,
        diskUsePercent: metrics.disk?.usePercent ?? null,
        failed: metrics.probes.filter((probe) => probe.status === 'failed').map((p) => p.key),
      },
      'relevé de métriques terminé',
    );
  } else {
    // Une cible éteinte n'est pas un incident du worker : la tâche réussit et
    // rend un rapport qui dit pourquoi elle n'a rien pu mesurer.
    log.warn({ error: metrics.error }, 'cible injoignable, relevé vide');
  }

  return metrics;
}
