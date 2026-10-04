import { usableRuntimes } from '@pupitre/core';
import { getDriver, type BuilderPruneResult } from '@pupitre/core/drivers';
import { disconnect } from '@pupitre/core/ssh';
import { listTargets, logAudit } from '@pupitre/db';
import type { Job } from 'bullmq';
import { openTargetContext } from '../deploy/target-context.js';
import { logger } from '../logger.js';

/**
 * Cleaning up image builders, once an hour.
 *
 * Each target is queried for the runtimes it runs and whose driver can expire a
 * builder — K3s sets up a BuildKit there, Docker builds without setting anything
 * up. What has not been used for a long time is removed by the driver; the
 * duration is its own. No session is opened to a target with nothing to expire.
 *
 * An unreachable target does not block the others: it is named in the report,
 * and the next pass retries.
 */
export type BuilderPruneJobResult = {
  targets: number;
  removed: Array<{ target: string; runtime: string; lastUsedAt: string | null }>;
  kept: number;
  failures: Array<{ target: string; runtime: string | null; error: string }>;
};

export async function handleBuilderPrune(job: Job): Promise<BuilderPruneJobResult> {
  const log = logger.child({ jobId: job.id, jobName: job.name });
  const result: BuilderPruneJobResult = { targets: 0, removed: [], kept: 0, failures: [] };

  for (const target of await listTargets()) {
    const runtimes = usableRuntimes(target.runtimesAvailable).filter(
      (runtime) => getDriver(runtime).pruneIdleBuilder !== undefined,
    );
    if (runtimes.length === 0) continue;
    result.targets += 1;

    let opened: Awaited<ReturnType<typeof openTargetContext>>;
    try {
      opened = await openTargetContext(target.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn({ targetId: target.id, err: error }, 'target unreachable for the builder cleanup');
      result.failures.push({ target: target.name, runtime: null, error: message });
      continue;
    }

    try {
      for (const runtime of runtimes) {
        let outcome: BuilderPruneResult;
        try {
          outcome = await getDriver(runtime).pruneIdleBuilder!(opened.ctx, (line) =>
            log.info({ targetId: target.id, runtime }, line),
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log.warn({ targetId: target.id, runtime, err: error }, 'builder cleanup failed');
          result.failures.push({ target: target.name, runtime, error: message });
          continue;
        }
        if (outcome.outcome === 'kept') result.kept += 1;
        if (outcome.outcome !== 'removed') continue;
        result.removed.push({ target: target.name, runtime, lastUsedAt: outcome.lastUsedAt });
        await logAudit({
          actorId: null,
          action: 'target.builder.removed',
          resourceType: 'target',
          resourceId: target.id,
          after: { runtime, lastUsedAt: outcome.lastUsedAt, reason: 'idle' },
          ip: null,
        });
      }
    } finally {
      await disconnect(opened.session);
    }
  }

  log.info(
    { targets: result.targets, removed: result.removed.length, failures: result.failures.length },
    'builders cleanup completed',
  );
  return result;
}
