import { targetMetricsJobDataSchema, type TargetMetricsJobResult } from '@pupitre/core';
import { getTarget } from '@pupitre/db';
import type { Job } from 'bullmq';
import { logger } from '../logger.js';
import { collectAndRecord } from '../supervision/collect.js';
import { judgeAndAnnounce } from '../supervision/judge.js';
import { judgeReachability } from '../supervision/reachability.js';
import {
  hostSweepJobDataSchema,
  sweepHosts,
  type HostSweepJobResult,
} from '../supervision/sweep.js';

/**
 * Reading a target machine's metrics — the "someone clicked" path.
 *
 * The counterpart of `target:preflight`, shorter: the preflight says *what can
 * be done* with the machine, the reading says *how it is doing*. No driver is
 * loaded here — load, memory and disk depend on no runtime, and that is exactly
 * why they live next to the preflight rather than in `DockerComposeDriver` and
 * `K3sDriver`.
 *
 * ── What changed, and why ───────────────────────────────────────────────────
 * This comment used to say the reading "is not stored": it travelled through the
 * BullMQ return value and died with the response. It was defensible for an
 * instant figure; it no longer is as soon as one wants to know whether a disk at
 * 89% was at 11% last week. The reading is therefore **written in passing**
 * (`collectAndRecord`) and thresholds are evaluated on it. The return value has
 * not changed by a field: the screen still shows the measurement of the second,
 * and the route waiting for it has nothing to know.
 *
 * A click is therefore worth a sweep reading — same write, same judgment, only
 * the `source` column differs. Refusing to keep a reading because it comes from
 * a human would have wasted an SSH session already paid for.
 *
 * Still no audit write for the reading itself: reading the load of a machine one
 * is already allowed to see changes nothing, and a screen reading ten servers
 * would drown the log. Only **crossing a threshold** writes one, and only when
 * it happens.
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
      'metrics reading completed',
    );
  } else {
    // A target turned off is not a worker incident: the job succeeds and returns a
    // report saying why it could measure nothing.
    log.warn({ error: metrics.error }, 'target unreachable, empty reading');
  }

  if (recorded) {
    // The judgment follows the same path as in the sweep. It is deliberately here
    // and not in `collectAndRecord`: writing is one thing, deciding that someone
    // must be woken up is another.
    try {
      const target = await getTarget(data.targetId);
      if (target) {
        await judgeReachability({ id: target.id, name: target.name });
        await judgeAndAnnounce({ id: target.id, name: target.name });
      }
    } catch (error) {
      // A badly judged threshold must not deprive the screen of its reading.
      log.error({ err: error }, 'thresholds evaluation failed');
    }
  }

  return metrics;
}

/**
 * The periodic sweep. A BullMQ envelope, nothing more: everything is in
 * `supervision/sweep.ts`.
 *
 * On the `supervision` queue, like the on-demand reading it is the twin of — a
 * read must neither delay a deployment nor be delayed by it.
 */
export async function handleTargetMetricsSweep(job: Job): Promise<HostSweepJobResult> {
  const data = hostSweepJobDataSchema.parse(job.data ?? {});
  const summary = await sweepHosts({ targetId: data.targetId, force: data.force });

  // A sweep that found nothing to do is the normal case: do not log a line every
  // minute to say there is nothing to say.
  if (summary.sampled > 0 || summary.pruned > 0) {
    logger.info({ jobId: job.id, ...summary }, 'servers sweep completed');
  }
  return summary;
}
