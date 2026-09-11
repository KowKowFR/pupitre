import { monitorSweepJobDataSchema, type MonitorSweepJobResult } from '@tp/core';
import type { Job } from 'bullmq';
import { logger } from '../logger.js';
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
