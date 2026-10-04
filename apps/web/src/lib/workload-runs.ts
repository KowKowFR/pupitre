import 'server-only';
import { getRedis } from './redis';

/**
 * Who a run on a workload belongs to — a log read, a command.
 *
 * Their lines go through the target's real-time channel, which every subscriber
 * with `workload:read` listens to. Yet a command's output or a container log can
 * carry secrets: it must only go to the person who asked for it. The run
 * identifier is drawn by the browser, which opens its stream **before** starting
 * the job (otherwise the first lines would be lost); the first opening reserves
 * it, for a quarter of an hour.
 */

const TTL_SECONDS = 15 * 60;

const keyOf = (run: string) => `workload-run:${run}`;

/** Reserves the run for this person, or confirms it is already theirs. */
export async function claimWorkloadRun(run: string, userId: string): Promise<boolean> {
  const redis = getRedis();
  const claimed = await redis.set(keyOf(run), userId, 'EX', TTL_SECONDS, 'NX');
  if (claimed === 'OK') return true;
  return (await redis.get(keyOf(run))) === userId;
}
