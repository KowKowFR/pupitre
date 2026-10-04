import 'server-only';
import {
  SUPERVISION_QUEUE,
  TARGET_METRICS_JOB,
  hostMetricsSchema,
  targetMetricsJobDataSchema,
  type HostMetrics,
} from '@pupitre/core';
import { QueueEvents } from 'bullmq';
import { targets as messages } from '@/i18n/messages/targets';
import { HttpError, msg } from '@/lib/errors';
import { getRedis } from '@/lib/redis';
import { getSupervisionQueue } from '@/lib/supervision-queue';

/**
 * Reading a target's metrics, seen from the panel.
 *
 * **Why a read goes through the queue.** The same reason as the workloads
 * inventory, and the pattern is reused as is: the Next panel opens no SSH session
 * and never will — `ssh2` is deliberately kept out of its dependency graph (see
 * `packages/core/src/index.ts`). "How many cores does this machine have?"
 * therefore has no local answer: the question is asked of the worker.
 *
 * **Why the route waits.** The rule is that long-running *work* has no place in
 * an HTTP route — not that the route must give control back before knowing. It
 * executes nothing: it queues, then waits, as it waits for an SQL query.
 *
 * **Why 20 seconds.** The reading is an SSH session opening (an 8 s guard, a
 * single attempt — see `collectHostMetrics`) then six reads of `/proc` capped at
 * 5 s each and started together: the worst case of a machine answering badly
 * fits under 15 s. The remaining margin covers waiting in the queue. Beyond that,
 * it is no longer the target that is slow, it is the worker that is not
 * consuming — and the caller deserves a plain 504 rather than a connection held
 * open. A target simply turned off, for its part, never uses this bound: it
 * returns a `reachable:false` report in ~8 s.
 */
const METRICS_TIMEOUT_MS = 20_000;

declare global {
  var __tpMetricsQueueEvents: QueueEvents | undefined;
}

/** Listening to the monitoring queue's job ends. Shared, like the queue. */
function queueEvents(): QueueEvents {
  globalThis.__tpMetricsQueueEvents ??= new QueueEvents(SUPERVISION_QUEUE, {
    connection: getRedis(),
  });
  return globalThis.__tpMetricsQueueEvents;
}

export async function fetchHostMetrics(
  targetId: string,
  actorId: string,
  ip: string | null,
): Promise<HostMetrics> {
  const data = targetMetricsJobDataSchema.parse({ targetId, actorId, ip });

  // No custom job identifier: BullMQ refuses a "Custom Id" containing a `:`, and
  // this job's name contains one.
  const job = await getSupervisionQueue().add(TARGET_METRICS_JOB, data, { attempts: 1 });

  let raw: unknown;
  try {
    raw = await job.waitUntilFinished(queueEvents(), METRICS_TIMEOUT_MS);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // `waitUntilFinished` only tells the timeout from the job's failure by its
    // message — two situations, two codes.
    if (/timed out/i.test(message)) {
      throw new HttpError(504, 'host_metrics_timeout', msg(messages, 'error.metricsTimeout'));
    }
    throw new HttpError(
      502,
      'host_metrics_failed',
      msg(messages, 'error.metricsFailed', { message }),
    );
  }

  const parsed = hostMetricsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(502, 'host_metrics_failed', msg(messages, 'error.metricsUnreadable'));
  }

  return parsed.data;
}
