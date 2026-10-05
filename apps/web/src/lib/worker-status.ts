import 'server-only';
import { cache } from 'react';
import { getOpsQueue } from './queue';

/**
 * Is the worker there? The answer of the top bar's "Worker active" chip.
 *
 * BullMQ names its workers' connections; `getWorkers()` reads them again in the
 * list of Redis clients. It is a read only, without asking the worker anything:
 * if it consumes the queue, its connection is there, and `idle` says for how many
 * seconds it has sent nothing to Redis — its last heartbeat.
 *
 * The read is bounded to 800 ms: a chip is not worth a slow Redis holding back
 * every page's render. Without an answer, the state is "unknown", and the chip
 * says so rather than assert anything.
 */

export type WorkerStatus =
  { state: 'active'; idleSeconds: number } | { state: 'idle' } | { state: 'unknown' };

const TIMEOUT_MS = 800;

export const workerStatus = cache(async (): Promise<WorkerStatus> => {
  try {
    const workers = await Promise.race([
      getOpsQueue().getWorkers(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), TIMEOUT_MS)),
    ]);
    if (workers === null) return { state: 'unknown' };
    if (workers.length === 0) return { state: 'idle' };
    const idle = Math.min(
      ...workers.map((worker) => {
        const value = Number((worker as Record<string, unknown>).idle);
        return Number.isFinite(value) ? value : 0;
      }),
    );
    return { state: 'active', idleSeconds: idle };
  } catch {
    return { state: 'unknown' };
  }
});
