import { targetMetricsJobDataSchema, type TargetMetricsJobResult } from '@pupitre/core';
import { getTarget } from '@pupitre/db';
import type { Job } from 'bullmq';
import { logger } from '../logger.js';
import { collectAndRecord } from '../supervision/collect.js';
import { judgeAndAnnounce } from '../supervision/judge.js';
import {
  hostSweepJobDataSchema,
  sweepHosts,
  type HostSweepJobResult,
} from '../supervision/sweep.js';

/**
 * Relevé des métriques d'une machine cible — le chemin « quelqu'un a cliqué ».
 *
 * Le pendant de `target:preflight`, en plus court : le preflight dit *ce qu'on
 * peut faire* de la machine, le relevé dit *comment elle se porte*. Aucun driver
 * n'est chargé ici — la charge, la mémoire et le disque ne dépendent d'aucun
 * runtime, et c'est exactement pour ça qu'ils vivent à côté du preflight plutôt
 * que dans `DockerComposeDriver` et `K3sDriver`.
 *
 * ── Ce qui a changé, et pourquoi ────────────────────────────────────────────
 * Ce commentaire disait auparavant que le relevé « ne se stocke pas » : il
 * voyageait par la valeur de retour BullMQ et mourait avec la réponse. C'était
 * défendable pour un chiffre instantané ; ça ne l'est plus dès qu'on veut savoir
 * si un disque à 89 % était à 11 % la semaine dernière. Le relevé est donc
 * **écrit au passage** (`collectAndRecord`) et les seuils sont évalués dessus.
 * La valeur de retour, elle, n'a pas bougé d'un champ : l'écran affiche toujours
 * la mesure de la seconde, et la route qui l'attend n'a rien à savoir.
 *
 * Un clic vaut donc un relevé du balayage — même écriture, même jugement, seule
 * la colonne `source` diffère. Refuser de garder un relevé parce qu'il vient
 * d'un humain aurait été gâcher une session SSH déjà payée.
 *
 * Toujours aucune écriture d'audit pour le relevé lui-même : lire la charge
 * d'une machine qu'on a déjà le droit de voir ne change rien, et un écran qui
 * relève dix serveurs noierait le journal. Seul le **franchissement de seuil**
 * en écrit une, et seulement au moment où il se produit.
 */
export async function handleTargetMetrics(
  job: Job<unknown, TargetMetricsJobResult>,
): Promise<TargetMetricsJobResult> {
  const data = targetMetricsJobDataSchema.parse(job.data);
  const log = logger.child({ jobId: job.id, jobName: job.name, targetId: data.targetId });

  const { metrics, recorded } = await collectAndRecord(data.targetId, 'manual');

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

  if (recorded) {
    // Le jugement suit le même chemin que dans le balayage. Il est délibérément
    // ici et non dans `collectAndRecord` : écrire est une chose, décider qu'il
    // faut réveiller quelqu'un en est une autre.
    try {
      const target = await getTarget(data.targetId);
      if (target) await judgeAndAnnounce({ id: target.id, name: target.name });
    } catch (error) {
      // Un seuil mal jugé ne doit pas priver l'écran de son relevé.
      log.error({ err: error }, 'évaluation des seuils impossible');
    }
  }

  return metrics;
}

/**
 * Le balayage périodique. Enveloppe BullMQ, rien de plus : tout est dans
 * `supervision/sweep.ts`.
 *
 * Sur la file `supervision`, comme le relevé à la demande dont il est le jumeau
 * — une lecture ne doit ni retarder un déploiement, ni être retardée par lui.
 */
export async function handleTargetMetricsSweep(job: Job): Promise<HostSweepJobResult> {
  const data = hostSweepJobDataSchema.parse(job.data ?? {});
  const summary = await sweepHosts({ targetId: data.targetId, force: data.force });

  // Un balayage qui n'a rien trouvé à faire est le cas normal : ne pas
  // journaliser une ligne toutes les minutes pour dire qu'il n'y a rien à dire.
  if (summary.sampled > 0 || summary.pruned > 0) {
    logger.info({ jobId: job.id, ...summary }, 'balayage des serveurs terminé');
  }
  return summary;
}
