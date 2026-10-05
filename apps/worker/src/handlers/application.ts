import {
  applicationDeleteJobDataSchema,
  type AbandonedWorkload,
  type ApplicationDeleteJobResult,
  type DestroyedDeployment,
  type UiLanguage,
} from '@pupitre/core';
import { getDriver } from '@pupitre/core/drivers';
import type { ConnectOptions } from '@pupitre/core/ssh';
import {
  deleteApplication,
  eraseApplication,
  getApplication,
  listApplicationDeletionBlockers,
  logAudit,
  purgeDeployments,
  type ApplicationDeletionBlocker,
  type PurgeRefusal,
} from '@pupitre/db';
import type { Job } from 'bullmq';
import { env } from '../env.js';
import { instanceLanguage } from '../language.js';
import { logger } from '../logger.js';
import { workerSay, type WorkerSay } from '../messages.js';
import { destroyDeployment } from './deployment.js';

/**
 * Cascading deletion of an application.
 *
 * Three chained gestures, in this order and no other: destroy on the machines,
 * purge the history, erase the application. The order is not a detail — purging
 * before destroying would lose the handles that are precisely used to destroy.
 *
 * ── The trade-off on partial failure ────────────────────────────────────────
 * Three deployments, the second target off. "All or nothing" cannot be
 * implemented: a successful destruction cannot be undone, one does not redeploy
 * an application to cancel a deletion. What remains is choosing between
 * stopping at the first failure and going on.
 *
 * We go on, and **delete nothing in the database**: each reachable target is
 * cleaned up, the dead target is named, and the application stays in the panel
 * with its whole history — that is with the handles that allow retrying, or
 * forcing knowingly. Running the cascade again only goes over what remains: the
 * deployments already destroyed no longer block. The operation declares itself
 * `deleted: false` and reports the exact list of what resisted. It is never
 * silently "half successful".
 */

/**
 * Bounded attempt, for the cascade's path only.
 *
 * A target turned off, with the SSH default (three fifteen-second attempts plus
 * backoff), is nearly a minute per deployment before the slightest word about
 * what blocks. Here we want a verdict: one attempt, ten seconds. We do not try to
 * succeed despite a capricious machine, we try to know.
 */
const CASCADE_CONNECT: Omit<ConnectOptions, 'language'> = { retries: 1, readyTimeout: 10_000 };

/** Cap on purge rounds — `purgeDeployments()` handles 500 rows per call. */
const PURGE_ROUNDS = 20;

export async function handleApplicationDelete(
  job: Job<unknown, ApplicationDeleteJobResult>,
): Promise<ApplicationDeleteJobResult> {
  const data = applicationDeleteJobDataSchema.parse(job.data);
  const log = logger.child({ jobId: job.id, applicationId: data.applicationId });

  // The report is shown on screen and kept in the activity log: in the instance's
  // language, like a deployment's log.
  const language = await instanceLanguage();
  const say = workerSay(language);

  const application = await getApplication(data.applicationId);
  if (!application) throw new Error(say('cascade.notFound', { id: data.applicationId }));

  const blockers = await listApplicationDeletionBlockers(data.applicationId, { language });

  // A deployment in progress is not destroyed, not purged, and forcing does not
  // change that: erasing the row under the worker writing it would produce an
  // incomprehensible error and a machine in an undetermined state. It is a state
  // that ends by itself in a few minutes — we wait.
  const inProgress = blockers.filter((blocker) => blocker.reason === 'in_progress');
  if (inProgress.length > 0) {
    throw new Error(
      say('cascade.inProgress', {
        count: inProgress.length,
        slug: application.slug,
        list: inProgress
          .map((blocker) =>
            say('cascade.identity', {
              slug: blocker.applicationSlug,
              version: blocker.version,
              target: blocker.targetName,
            }),
          )
          .join(', '),
      }),
    );
  }

  const live = blockers.filter((blocker) => blocker.reason === 'live');
  log.info({ live: live.length, force: data.force }, 'cascading deletion started');

  const destroyed: DestroyedDeployment[] = [];
  const abandoned: AbandonedWorkload[] = [];

  for (const blocker of live) {
    try {
      await destroyDeployment(blocker.id, {
        actorId: data.actorId,
        ip: data.ip,
        connect: CASCADE_CONNECT,
      });
      destroyed.push({
        deploymentId: blocker.id,
        version: blocker.version,
        targetId: blocker.targetId,
        targetName: blocker.targetName,
      });
      log.info({ deploymentId: blocker.id, target: blocker.targetName }, 'deployment destroyed');
    } catch (error) {
      const residue = describeResidue(blocker, error);
      abandoned.push(residue);
      log.warn(
        { deploymentId: blocker.id, target: blocker.targetName, error: residue.error },
        'destruction failed',
      );
    }
  }

  const base = {
    applicationId: application.id,
    applicationSlug: application.slug,
    forced: data.force,
    destroyed,
    abandoned,
  };

  // ── Partial failure without forcing: we do not touch the database ──────────
  if (abandoned.length > 0 && !data.force) {
    const summary = say('cascade.partial', {
      destroyed: destroyed.length,
      abandoned: abandoned.length,
      residues: abandoned.map((residue) => residueIdentity(residue, say)).join(' ; '),
      slug: application.slug,
    });

    await logAudit({
      actorId: data.actorId,
      action: 'application.delete.failed',
      resourceType: 'application',
      resourceId: application.id,
      before: { slug: application.slug },
      after: { forced: false, destroyed, abandoned, summary },
      ip: data.ip,
    });

    log.warn({ abandoned: abandoned.length }, 'cascade interrupted, nothing erased');
    return { ...base, deleted: false, purgedCount: 0, releasedPorts: [], summary };
  }

  // ── Everything was destroyed: the purge keeps its safeguard ────────────────
  if (abandoned.length === 0) {
    const purge = await purgeAll(application.id, language);

    if (purge.refused.length > 0) {
      // Safety net: the purge still sees something alive although every destruction
      // succeeded. We prefer to refuse and say so.
      const summary = say('cascade.historyStuck', {
        refusals: purge.refused.map((refusal) => refusal.message).join(' ; '),
      });

      await logAudit({
        actorId: data.actorId,
        action: 'application.delete.failed',
        resourceType: 'application',
        resourceId: application.id,
        before: { slug: application.slug },
        after: { forced: false, destroyed, refused: purge.refused, summary },
        ip: data.ip,
      });

      return {
        ...base,
        deleted: false,
        purgedCount: purge.purged.length,
        releasedPorts: purge.releasedPorts,
        summary,
      };
    }

    await deleteApplication(application.id);

    const summary = say('cascade.deleted', {
      slug: application.slug,
      destroyed: destroyed.length,
      purged: purge.purged.length,
      ports: describePorts(purge.releasedPorts, say),
    });

    await logAudit({
      actorId: data.actorId,
      action: 'application.deleted',
      resourceType: 'application',
      resourceId: application.id,
      before: { slug: application.slug },
      after: {
        cascade: true,
        forced: false,
        destroyed,
        purgedCount: purge.purged.length,
        purgedIds: purge.purged,
        releasedPorts: purge.releasedPorts,
        summary,
      },
      ip: data.ip,
    });

    log.info({ purged: purge.purged.length }, 'application deleted in cascade');
    return {
      ...base,
      deleted: true,
      purgedCount: purge.purged.length,
      releasedPorts: purge.releasedPorts,
      summary,
    };
  }

  // ── Forcing: we erase knowing what we abandon ──────────────────────────────
  //
  // The audit entry written here is the ONLY trace that will remain: once the
  // transaction is through, nothing in the panel can name what still runs on
  // these machines. It is therefore written with what is needed to finish the
  // cleanup by hand — host, Compose project or namespace, port — and not with a
  // count.
  const erasure = await eraseApplication(application.id);
  if (!erasure) throw new Error(say('cascade.alreadyErased', { id: application.id }));

  const summary = say('cascade.forced', {
    slug: application.slug,
    destroyed: destroyed.length,
    abandoned: abandoned.length,
    residues: abandoned.map((residue) => residueIdentity(residue, say)).join(' ; '),
    ports: describePorts(erasure.releasedPorts, say),
  });

  await logAudit({
    actorId: data.actorId,
    action: 'application.delete.forced',
    resourceType: 'application',
    resourceId: application.id,
    before: { slug: application.slug },
    after: {
      forced: true,
      destroyed,
      /** What remains to clean up by hand, machine by machine. */
      abandoned,
      erasedDeploymentIds: erasure.deploymentIds,
      erasedDeploymentCount: erasure.deploymentIds.length,
      releasedPorts: erasure.releasedPorts,
      /** The commands to run on each machine to finish the work. */
      manualCleanup: abandoned.map((residue) => cleanupHint(residue, application.slug)),
      summary,
    },
    ip: data.ip,
  });

  log.warn(
    { abandoned: abandoned.length, erased: erasure.deploymentIds.length },
    'application erased by force — workloads remain on the targets',
  );

  return {
    ...base,
    deleted: true,
    purgedCount: erasure.deploymentIds.length,
    releasedPorts: erasure.releasedPorts,
    summary,
  };
}

/**
 * Purges the application's whole history, in rounds of `PURGE_MAX_ROWS`.
 *
 * Goes through `purgeDeployments()` and not a home-made `DELETE`: it is the one
 * carrying the "alive" safeguard, the release of orphan ports and the cascade on
 * steps and scans. The cascade has no reason to have its own version of all
 * that.
 */
async function purgeAll(
  applicationId: string,
  language: UiLanguage,
): Promise<{
  purged: string[];
  releasedPorts: Array<{ targetId: string; targetName: string; port: number }>;
  refused: PurgeRefusal[];
}> {
  const purged: string[] = [];
  const releasedPorts: Array<{ targetId: string; targetName: string; port: number }> = [];
  let refused: PurgeRefusal[] = [];

  for (let round = 0; round < PURGE_ROUNDS; round += 1) {
    const report = await purgeDeployments({ applicationId }, { language });
    purged.push(...report.purged);
    releasedPorts.push(...report.releasedPorts);
    refused = report.refused;
    if (!report.truncated || report.purgedCount === 0) break;
  }

  return { purged, releasedPorts, refused };
}

/**
 * Names what a deployment leaves behind when its destruction fails.
 *
 * The grouping's name — Compose project or namespace — comes from the driver,
 * through `workspaceName()`. Deriving it here would amount to writing
 * `app-${slug}` outside a driver class, that is leaking a runtime's vocabulary
 * into code that does not have to know it.
 */
function describeResidue(
  blocker: ApplicationDeletionBlocker,
  error: unknown,
): AbandonedWorkload {
  return {
    deploymentId: blocker.id,
    version: blocker.version,
    status: blocker.status,
    runtime: blocker.runtime,
    targetId: blocker.targetId,
    targetName: blocker.targetName,
    targetHost: blocker.targetHost,
    workspace: getDriver(blocker.runtime).workspaceName(blocker.applicationSlug),
    publishedPort: blocker.publishedPort,
    error: error instanceof Error ? error.message : String(error),
  };
}

function residueIdentity(residue: AbandonedWorkload, say: WorkerSay): string {
  return say('cascade.residue', {
    workspace: residue.workspace,
    target: residue.targetName,
    host: residue.targetHost,
    port:
      residue.publishedPort === null
        ? say('cascade.noPort')
        : say('cascade.port', { port: residue.publishedPort }),
    error: residue.error,
  });
}

/**
 * What is needed to take back control without the panel: where to connect, and
 * what to do there.
 *
 * The commands come from the driver (`manualCleanup()`), never from an `if` on
 * the runtime written here — that would be exactly the divergence rule 1
 * forbids.
 */
function cleanupHint(
  residue: AbandonedWorkload,
  appSlug: string,
): {
  host: string;
  runtime: 'docker' | 'k3s';
  workspace: string;
  publishedPort: number | null;
  commands: string[];
} {
  return {
    host: residue.targetHost,
    runtime: residue.runtime,
    workspace: residue.workspace,
    publishedPort: residue.publishedPort,
    commands: getDriver(residue.runtime).manualCleanup(appSlug, env.DRIVER_ROOT_PATH),
  };
}

function describePorts(ports: Array<{ targetName: string; port: number }>, say: WorkerSay): string {
  if (ports.length === 0) return say('cascade.noPortToRelease');
  return say('cascade.portsReleased', {
    ports: ports
      .map((entry) => say('cascade.portOn', { port: entry.port, target: entry.targetName }))
      .join(', '),
  });
}
