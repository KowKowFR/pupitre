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
 * Suppression en cascade d'une application.
 *
 * Trois gestes enchaînés, dans cet ordre et pas un autre : détruire sur les
 * machines, purger l'historique, effacer l'application. L'ordre n'est pas un
 * détail — purger avant de détruire ferait perdre les poignées qui servent
 * justement à détruire.
 *
 * ── L'arbitrage sur l'échec partiel ──────────────────────────────────────────
 * Trois déploiements, la deuxième cible éteinte. « Tout ou rien » n'est pas
 * implémentable : une destruction réussie ne se défait pas, on ne redéploie pas
 * une application pour annuler une suppression. Reste donc à choisir entre
 * s'arrêter au premier échec et continuer.
 *
 * On continue, et on **ne supprime rien en base** : chaque cible joignable est
 * nettoyée, la cible morte est nommée, et l'application reste dans le panel
 * avec tout son historique — c'est-à-dire avec les poignées qui permettent de
 * réessayer, ou de forcer en connaissance de cause. Relancer la cascade ne
 * repasse que sur ce qui reste : les déploiements déjà détruits ne bloquent
 * plus. L'opération se déclare `deleted: false` et rapporte la liste exacte de
 * ce qui a résisté. Elle n'est jamais « réussie à moitié » en silence.
 */

/**
 * Tentative bornée, pour le seul chemin de la cascade.
 *
 * Une cible éteinte, avec le défaut SSH (trois essais de quinze secondes plus
 * le backoff), c'est près d'une minute par déploiement avant le moindre mot sur
 * ce qui bloque. Ici on veut un verdict : un essai, dix secondes. On ne cherche
 * pas à réussir malgré une machine capricieuse, on cherche à savoir.
 */
const CASCADE_CONNECT: ConnectOptions = { retries: 1, readyTimeout: 10_000 };

/** Plafond de tours de purge — `purgeDeployments()` traite 500 lignes par appel. */
const PURGE_ROUNDS = 20;

export async function handleApplicationDelete(
  job: Job<unknown, ApplicationDeleteJobResult>,
): Promise<ApplicationDeleteJobResult> {
  const data = applicationDeleteJobDataSchema.parse(job.data);
  const log = logger.child({ jobId: job.id, applicationId: data.applicationId });

  // Le compte rendu est montré à l'écran et gardé au journal d'activité : dans
  // la langue de l'instance, comme le journal d'un déploiement.
  const language = await instanceLanguage();
  const say = workerSay(language);

  const application = await getApplication(data.applicationId);
  if (!application) throw new Error(say('cascade.notFound', { id: data.applicationId }));

  const blockers = await listApplicationDeletionBlockers(data.applicationId, { language });

  // Un déploiement en cours ne se détruit pas, ne se purge pas, et le forçage
  // ne le change pas : effacer la ligne sous le worker qui l'écrit produirait
  // une erreur incompréhensible et une machine dans un état indéterminé.
  // C'est un état qui se termine tout seul en quelques minutes — on attend.
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
  log.info({ live: live.length, force: data.force }, 'suppression en cascade démarrée');

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
      log.info({ deploymentId: blocker.id, target: blocker.targetName }, 'déploiement détruit');
    } catch (error) {
      const residue = describeResidue(blocker, error);
      abandoned.push(residue);
      log.warn(
        { deploymentId: blocker.id, target: blocker.targetName, error: residue.error },
        'destruction impossible',
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

  // ── Échec partiel sans forçage : on ne touche pas à la base ────────────────
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

    log.warn({ abandoned: abandoned.length }, 'cascade interrompue, rien effacé');
    return { ...base, deleted: false, purgedCount: 0, releasedPorts: [], summary };
  }

  // ── Tout a été détruit : la purge garde son garde-fou ──────────────────────
  if (abandoned.length === 0) {
    const purge = await purgeAll(application.id, language);

    if (purge.refused.length > 0) {
      // Filet de sécurité : la purge voit encore quelque chose de vivant alors
      // que toutes les destructions ont réussi. On préfère refuser et le dire.
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

    log.info({ purged: purge.purged.length }, 'application supprimée en cascade');
    return {
      ...base,
      deleted: true,
      purgedCount: purge.purged.length,
      releasedPorts: purge.releasedPorts,
      summary,
    };
  }

  // ── Forçage : on efface en sachant ce qu'on abandonne ──────────────────────
  //
  // L'entrée d'audit écrite ici est la SEULE trace qui subsistera : dès la
  // transaction passée, plus rien dans le panel ne sait nommer ce qui tourne
  // encore sur ces machines. Elle est donc écrite avec de quoi finir le ménage
  // à la main — hôte, projet Compose ou namespace, port — et non avec un
  // décompte.
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
      /** Ce qui reste à nettoyer à la main, machine par machine. */
      abandoned,
      erasedDeploymentIds: erasure.deploymentIds,
      erasedDeploymentCount: erasure.deploymentIds.length,
      releasedPorts: erasure.releasedPorts,
      /** Les commandes à passer sur chaque machine pour finir le travail. */
      manualCleanup: abandoned.map((residue) => cleanupHint(residue, application.slug)),
      summary,
    },
    ip: data.ip,
  });

  log.warn(
    { abandoned: abandoned.length, erased: erasure.deploymentIds.length },
    'application effacée de force — des charges restent sur les cibles',
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
 * Purge tout l'historique de l'application, par tours de `PURGE_MAX_ROWS`.
 *
 * Passe par `purgeDeployments()` et non par un `DELETE` maison : c'est elle qui
 * porte le garde-fou du vivant, la libération des ports orphelins et la cascade
 * sur les steps et les scans. La cascade n'a aucune raison d'avoir sa propre
 * version de tout ça.
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
 * Nomme ce qu'un déploiement laisse derrière lui quand sa destruction échoue.
 *
 * Le nom du regroupement — projet Compose ou namespace — vient du driver, via
 * `workspaceName()`. Le déduire ici reviendrait à écrire `app-${slug}` hors
 * d'une classe de driver, c'est-à-dire à faire fuir le vocabulaire d'un runtime
 * dans du code qui n'a pas à le connaître.
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
 * De quoi reprendre la main sans le panel : où se connecter, et quoi y faire.
 *
 * Les commandes viennent du driver (`manualCleanup()`), jamais d'un `if` sur le
 * runtime écrit ici — ce serait exactement la divergence que la règle 1
 * interdit.
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
