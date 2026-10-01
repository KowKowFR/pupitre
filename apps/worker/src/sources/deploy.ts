import {
  DEPLOYMENT_RUN_JOB,
  deploymentJobDataSchema,
  scanConfigFromSettings,
  usableRuntimes,
  type AppSpec,
  type SourceCommit,
} from '@pupitre/core';
import {
  createDeploymentWithSteps,
  getAppSettingsValue,
  getApplication,
  getTarget,
  logAudit,
  supersedePendingProposals,
  updateApplication,
  type ApplicationSourceView,
} from '@pupitre/db';
import { logger } from '../logger.js';
import { getOpsQueue } from '../queue.js';
import { reportDeploymentStatus } from './status.js';

/**
 * Déployer un commit d'un dépôt lié sur les cibles de la liaison.
 *
 * Un seul chemin, que la décision vienne du polling (`auto`), d'un clic sur
 * « Déployer ce commit » (`manual`) ou de la validation d'un commit en attente
 * (`proposal`). Il fait ce que fait `POST /api/deployments`, pour chaque cible :
 * la politique de scan de l'instance s'applique, le preflight fait foi sur le
 * runtime, le run part en file et s'écrit au journal — avec, en plus, le
 * dépôt, la branche et le commit exact.
 *
 * Le catalogue suit le dépôt : l'AppSpec de l'application devient celle du
 * commit. C'est elle que la fiche montre et qu'un prochain commit comparera.
 */
export type SourceDeployResult = {
  created: Array<{ id: string; number: number; targetName: string }>;
  skipped: Array<{ targetName: string; reason: string }>;
};

export async function deployFromSource(input: {
  source: ApplicationSourceView;
  sha: string;
  spec: AppSpec;
  commit: SourceCommit | null;
  trigger: 'auto' | 'manual' | 'proposal';
  /** La proposition validée, qui ne doit pas être rendue caduque par ce déploiement. */
  proposalId?: string | null;
  actorId: string | null;
  ip: string | null;
}): Promise<SourceDeployResult> {
  const { source, sha, spec, commit } = input;
  const application = await getApplication(source.applicationId);
  if (!application) throw new Error(`application « ${source.applicationId} » introuvable`);

  await updateApplication(application.id, { appSpec: spec });

  const settings = await getAppSettingsValue();
  const scanConfig = scanConfigFromSettings(settings.security);
  const result: SourceDeployResult = { created: [], skipped: [] };

  for (const binding of source.targets) {
    const target = await getTarget(binding.targetId);
    if (!target) {
      result.skipped.push({ targetName: binding.targetName, reason: 'cible supprimée' });
      continue;
    }
    // Le preflight fait foi, comme pour un déploiement lancé à la main.
    if (!usableRuntimes(target.runtimesAvailable).includes(binding.runtime)) {
      result.skipped.push({
        targetName: target.name,
        reason:
          target.lastPreflightAt === null
            ? 'jamais testée : lancez un preflight'
            : `${binding.runtime} indisponible sur cette cible`,
      });
      continue;
    }

    const { deployment } = await createDeploymentWithSteps({
      applicationId: application.id,
      targetId: target.id,
      runtime: binding.runtime,
      proxy: 'traefik',
      scanConfig,
      autoRollback: true,
      appSpec: spec,
      triggeredBy: input.actorId,
      source: { sourceId: source.id, repository: source.repository, ref: source.branch, sha },
    });

    const job = await getOpsQueue().add(
      DEPLOYMENT_RUN_JOB,
      deploymentJobDataSchema.parse({
        deploymentId: deployment.id,
        actorId: input.actorId,
        ip: input.ip,
      }),
      { attempts: 1 },
    );

    await logAudit({
      actorId: input.actorId,
      action: 'deployment.created',
      resourceType: 'deployment',
      resourceId: deployment.id,
      after: {
        applicationSlug: application.slug,
        targetName: target.name,
        runtime: binding.runtime,
        proxy: 'traefik',
        number: deployment.number,
        version: deployment.version,
        scanners: scanConfig.scanners,
        failOn: scanConfig.failOn,
        autoRollback: true,
        jobId: job.id,
        via: 'source',
        trigger: input.trigger,
        repository: source.repository,
        ref: source.branch,
        sha,
        commitAuthor: commit?.author ?? null,
      },
      ip: input.ip,
    });

    await reportDeploymentStatus(deployment.id, 'pending');
    result.created.push({ id: deployment.id, number: deployment.number, targetName: target.name });
    logger.info(
      { deploymentId: deployment.id, repository: source.repository, sha, trigger: input.trigger },
      'déploiement enfilé depuis un dépôt',
    );
  }

  // Un commit plus récent vient de partir : les précédents en attente n'ont
  // plus d'objet.
  await supersedePendingProposals(source.id, input.proposalId ?? null);
  return result;
}

/** Les cibles écartées, en une phrase pour la liaison. `null` s'il n'y en a pas. */
export function skippedSummary(result: SourceDeployResult): string | null {
  if (result.skipped.length === 0) return null;
  return result.skipped.map((entry) => `${entry.targetName} : ${entry.reason}`).join(' · ');
}
