import {
  monitorCaptureJobDataSchema,
  monitorSweepJobDataSchema,
  type MonitorCaptureJobResult,
  type MonitorSweepJobResult,
} from '@pupitre/core';
import type { Job } from 'bullmq';
import { logger } from '../logger.js';
import { runMonitorCapture } from '../monitors/capture.js';
import { sweepMonitors } from '../monitors/sweep.js';

/**
 * Enveloppe BullMQ du balayage de supervision.
 *
 * Sur la file `supervision` : sonder un site est une **lecture**. Elle ne doit
 * ni retarder un déploiement, ni être retardée par lui. C'est exactement la
 * raison d'être de cette file.
 */
export async function handleMonitorSweep(job: Job): Promise<MonitorSweepJobResult> {
  const data = monitorSweepJobDataSchema.parse(job.data ?? {});
  const summary = await sweepMonitors({ monitorId: data.monitorId, force: data.force });

  if (summary.probed > 0 || summary.suspended > 0 || summary.pruned > 0) {
    logger.info({ jobId: job.id, ...summary }, 'balayage de supervision terminé');
  }
  return summary;
}

/**
 * Enveloppe BullMQ des captures d'écran.
 *
 * Sur la même file que le balayage — c'est un chargement de page vers
 * l'extérieur, donc une lecture — mais dans **sa propre tâche**, et c'est tout
 * l'intérêt : le balayage a déjà rendu son verdict et émis son alerte quand
 * celle-ci démarre. Une capture lente, ratée, ou impossible parce que le
 * navigateur est éteint ne retarde donc rien et ne casse rien.
 *
 * La tâche ne rejette jamais pour une capture manquée : elle rend un
 * compte-rendu qui dit pourquoi. Un `attempts: 1` à l'enfilage complète la
 * règle — rejouer une capture trois minutes plus tard montrerait un autre
 * instant que celui qu'on voulait garder.
 */
export async function handleMonitorCapture(job: Job): Promise<MonitorCaptureJobResult> {
  const data = monitorCaptureJobDataSchema.parse(job.data ?? {});
  const summary = await runMonitorCapture(data);

  if (summary.stored > 0) {
    logger.info({ jobId: job.id, ...summary }, 'captures enregistrées');
  } else if (summary.skipped.length > 0) {
    logger.debug({ jobId: job.id, ...summary }, 'aucune capture enregistrée');
  }
  return summary;
}
