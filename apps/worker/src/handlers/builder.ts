import { usableRuntimes } from '@pupitre/core';
import { getDriver, type BuilderPruneResult } from '@pupitre/core/drivers';
import { disconnect } from '@pupitre/core/ssh';
import { listTargets, logAudit } from '@pupitre/db';
import type { Job } from 'bullmq';
import { openTargetContext } from '../deploy/target-context.js';
import { logger } from '../logger.js';

/**
 * Le ménage des constructeurs d'images, une fois par heure.
 *
 * Chaque cible est interrogée pour les runtimes qu'elle fait tourner et dont
 * le driver sait expirer un constructeur — K3s y pose un BuildKit, Docker
 * construit sans rien poser. Ce qui n'a pas servi depuis longtemps est retiré
 * par le driver ; la durée est la sienne. Aucune session n'est ouverte vers
 * une cible qui n'a rien à expirer.
 *
 * Une cible injoignable ne bloque pas les autres : elle est nommée dans le
 * rapport, et le prochain passage réessaie.
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
      log.warn(
        { targetId: target.id, err: error },
        'cible injoignable pour le ménage du constructeur',
      );
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
          log.warn(
            { targetId: target.id, runtime, err: error },
            'ménage du constructeur impossible',
          );
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
    'ménage des constructeurs terminé',
  );
  return result;
}
