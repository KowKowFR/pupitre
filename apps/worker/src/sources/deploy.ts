import {
  DEPLOYMENT_RUN_JOB,
  deploymentJobDataSchema,
  scanConfigFromSettings,
  usableRuntimes,
  withApplicationScanPolicy,
  type AppSpec,
  type SourceCommit,
} from '@pupitre/core';
import {
  applicationScanPolicyOf,
  createDeploymentWithSteps,
  getAppSettingsValue,
  getApplication,
  getSourceConnectionById,
  getTarget,
  listLiveDeployments,
  logAudit,
  markSourceSynced,
  sourceRepositoryUrl,
  supersedePendingProposals,
  updateApplication,
  type ApplicationSourceView,
  type SourceTarget,
} from '@pupitre/db';
import { instanceLanguage } from '../language.js';
import { logger } from '../logger.js';
import { workerSay } from '../messages.js';
import { getOpsQueue } from '../queue.js';
import {
  panelUrl,
  reportCommitStatus,
  reportDeploymentStatus,
  statusLanguage,
  statusText,
} from './status.js';

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

/**
 * Où part un commit de cette liaison, à cet instant :
 *   targets  les cibles de la liaison ;
 *   running  là où l'application est en service — redéployer ce qui tourne,
 *            ne rien installer ailleurs ;
 *   none     nulle part : on la déploie à la main, où l'on veut.
 */
export async function bindingsFor(source: ApplicationSourceView): Promise<SourceTarget[]> {
  if (source.deployTo === 'targets') return source.targets;
  if (source.deployTo === 'none') return [];
  const live = await listLiveDeployments({ applicationId: source.applicationId });
  const bindings: SourceTarget[] = [];
  for (const couple of live) {
    const running = couple.inService;
    if (!running || running.stoppedAt) continue;
    const target = await getTarget(couple.targetId);
    bindings.push({
      targetId: couple.targetId,
      runtime: running.runtime,
      targetName: target?.name ?? couple.targetId,
    });
  }
  return bindings;
}

/**
 * L'application prend la version d'un commit, sans être déployée : son AppSpec
 * devient celle du commit, et c'est son code qu'un déploiement à la main
 * construira. Le commit le dit sur GitHub.
 */
export async function syncFromSource(input: {
  source: ApplicationSourceView;
  sha: string;
  spec: AppSpec;
  trigger: 'auto' | 'manual' | 'proposal';
  /** L'application devait être redéployée là où elle tourne, mais ne tourne nulle part. */
  idle?: boolean;
  proposalId?: string | null;
  actorId: string | null;
  ip: string | null;
}): Promise<void> {
  const { source, sha, spec } = input;
  const application = await getApplication(source.applicationId);
  if (!application) throw new Error(`application « ${source.applicationId} » introuvable`);
  await updateApplication(application.id, { appSpec: spec });
  await markSourceSynced(source.id, sha);
  await supersedePendingProposals(source.id, input.proposalId ?? null);
  await logAudit({
    actorId: input.actorId,
    action: 'source.commit.synced',
    resourceType: 'application',
    resourceId: application.id,
    after: {
      applicationSlug: application.slug,
      repository: source.repository,
      branch: source.branch,
      sha,
      version: spec.version,
      trigger: input.trigger,
    },
    ip: input.ip,
  });
  const language = await statusLanguage();
  const base = panelUrl();
  await reportCommitStatus(source, sha, {
    state: 'success',
    description: statusText(language, input.idle ? 'synced.idle' : 'synced'),
    context: 'pupitre',
    targetUrl: base ? `${base}/applications/${application.id}` : null,
  });
  logger.info(
    { repository: source.repository, sha },
    'version prise depuis un dépôt, sans déploiement',
  );
}

export async function deployFromSource(input: {
  source: ApplicationSourceView;
  sha: string;
  spec: AppSpec;
  commit: SourceCommit | null;
  trigger: 'auto' | 'manual' | 'proposal';
  /** Où déployer : `bindingsFor(source)` au moment de la décision. */
  bindings: SourceTarget[];
  /** La proposition validée, qui ne doit pas être rendue caduque par ce déploiement. */
  proposalId?: string | null;
  actorId: string | null;
  ip: string | null;
}): Promise<SourceDeployResult> {
  const { source, sha, spec, commit } = input;
  const application = await getApplication(source.applicationId);
  if (!application) throw new Error(`application « ${source.applicationId} » introuvable`);

  await updateApplication(application.id, { appSpec: spec });
  await markSourceSynced(source.id, sha);

  const settings = await getAppSettingsValue();
  // La politique de l'instance, puis le réglage propre à l'application.
  const scanConfig = withApplicationScanPolicy(
    scanConfigFromSettings(settings.security),
    applicationScanPolicyOf(application),
  );
  const result: SourceDeployResult = { created: [], skipped: [] };
  // L'adresse du dépôt chez sa forge : le déploiement la garde, et le lien
  // vers son commit en découle — même si la liaison disparaît ensuite.
  const connection = await getSourceConnectionById(source.connectionId);
  const repositoryUrl = connection ? sourceRepositoryUrl(connection, source.repository) : null;
  const say = workerSay(await instanceLanguage());

  for (const binding of input.bindings) {
    const target = await getTarget(binding.targetId);
    if (!target) {
      result.skipped.push({
        targetName: binding.targetName,
        reason: say('sourceDeploy.targetGone'),
      });
      continue;
    }
    // Le preflight fait foi, comme pour un déploiement lancé à la main.
    if (!usableRuntimes(target.runtimesAvailable).includes(binding.runtime)) {
      result.skipped.push({
        targetName: target.name,
        reason:
          target.lastPreflightAt === null
            ? say('sourceDeploy.neverTested')
            : say('sourceDeploy.runtimeUnavailable', { runtime: binding.runtime }),
      });
      continue;
    }

    const { deployment } = await createDeploymentWithSteps({
      applicationId: application.id,
      targetId: target.id,
      runtime: binding.runtime,
      scanConfig,
      autoRollback: true,
      appSpec: spec,
      triggeredBy: input.actorId,
      source: {
        sourceId: source.id,
        repository: source.repository,
        ref: source.branch,
        sha,
        url: repositoryUrl,
      },
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
