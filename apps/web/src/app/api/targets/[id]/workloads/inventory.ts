import 'server-only';
import {
  SUPERVISION_QUEUE,
  WORKLOAD_LIST_JOB,
  encodeWorkloadRef,
  workloadListJobDataSchema,
  workloadListSchema,
  type Workload,
  type WorkloadList,
} from '@pupitre/core';
import { QueueEvents } from 'bullmq';
import { targets as messages } from '@/i18n/messages/targets';
import { HttpError, msg } from '@/lib/errors';
import { getRedis } from '@/lib/redis';
import { getSupervisionQueue } from '@/lib/supervision-queue';

/**
 * A target's workloads inventory, seen from the panel.
 *
 * **Why a read still goes through the queue.** The Next panel opens no SSH
 * session, and never will: `ssh2` is deliberately kept out of its dependency
 * graph (see `packages/core/src/index.ts`), and the drivers are only importable
 * under `@pupitre/core/drivers`, on the worker side. The question "what runs on
 * this machine?" therefore has no local answer: it is asked of the worker, like
 * `target:preflight`.
 *
 * **Why the route waits all the same.** The rule is that long-running *work* has
 * no place in an HTTP route — not that the route must give control back before
 * knowing. Here the route executes nothing: it queues, then waits for an answer,
 * exactly as it waits for an SQL query. `docker ps` takes a second, and making a
 * client post then poll to show a table would be paying in complexity for a
 * problem we do not have. The 25 s guard is there for the case where the machine
 * no longer answers: beyond it, the route returns a 504 rather than hold the
 * connection.
 *
 * The result goes through no table: an inventory is true at the second it is
 * taken. It travels through the BullMQ return value.
 */

const INVENTORY_TIMEOUT_MS = 25_000;

declare global {
  var __tpWorkloadQueueEvents: QueueEvents | undefined;
}

/** Listening to the monitoring queue's job ends. Shared, like the queue. */
function queueEvents(): QueueEvents {
  globalThis.__tpWorkloadQueueEvents ??= new QueueEvents(SUPERVISION_QUEUE, {
    connection: getRedis(),
  });
  return globalThis.__tpWorkloadQueueEvents;
}

export async function fetchWorkloads(
  targetId: string,
  actorId: string,
  ip: string | null,
): Promise<WorkloadList> {
  const data = workloadListJobDataSchema.parse({ targetId, actorId, ip });

  // No custom job identifier: BullMQ refuses a "Custom Id" containing a `:`, and
  // our references all contain one.
  const job = await getSupervisionQueue().add(WORKLOAD_LIST_JOB, data, { attempts: 1 });

  let raw: unknown;
  try {
    raw = await job.waitUntilFinished(queueEvents(), INVENTORY_TIMEOUT_MS);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // `waitUntilFinished` does not tell the job's failure from the timeout other than
    // by its message: the two still deserve two different codes for the caller.
    if (/timed out/i.test(message)) {
      throw new HttpError(504, 'workload_list_timeout', msg(messages, 'error.inventoryTimeout'));
    }
    throw new HttpError(
      502,
      'workload_list_failed',
      msg(messages, 'error.inventoryFailed', { message }),
    );
  }

  const parsed = workloadListSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(502, 'workload_list_failed', msg(messages, 'error.inventoryUnreadable'));
  }

  return parsed.data;
}

/** Finds a workload by its transportable reference. */
export function findWorkload(list: WorkloadList, encodedRef: string): Workload | null {
  return list.items.find((item) => encodeWorkloadRef(item) === encodedRef) ?? null;
}
