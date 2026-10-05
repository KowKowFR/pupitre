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
 * BullMQ envelope of the monitoring sweep.
 *
 * On the `supervision` queue: probing a site is a **read**. It must neither
 * delay a deployment nor be delayed by it. That is exactly this queue's reason
 * for being.
 */
export async function handleMonitorSweep(job: Job): Promise<MonitorSweepJobResult> {
  const data = monitorSweepJobDataSchema.parse(job.data ?? {});
  const summary = await sweepMonitors({ monitorId: data.monitorId, force: data.force });

  if (summary.probed > 0 || summary.suspended > 0 || summary.pruned > 0) {
    logger.info({ jobId: job.id, ...summary }, 'monitoring sweep completed');
  }
  return summary;
}

/**
 * BullMQ envelope of the screenshots.
 *
 * On the same queue as the sweep — it is a page load toward the outside, hence a
 * read — but in **its own job**, and that is the whole point: the sweep has
 * already given its verdict and sent its alert when this one starts. A slow,
 * failed capture, or one impossible because the browser is off, therefore
 * delays nothing and breaks nothing.
 *
 * The job never rejects for a missed capture: it returns a report saying why. An
 * `attempts: 1` at queuing completes the rule — replaying a capture three
 * minutes later would show another instant than the one we wanted to keep.
 */
export async function handleMonitorCapture(job: Job): Promise<MonitorCaptureJobResult> {
  const data = monitorCaptureJobDataSchema.parse(job.data ?? {});
  const summary = await runMonitorCapture(data);

  if (summary.stored > 0) {
    logger.info({ jobId: job.id, ...summary }, 'captures recorded');
  } else if (summary.skipped.length > 0) {
    logger.debug({ jobId: job.id, ...summary }, 'no capture recorded');
  }
  return summary;
}
