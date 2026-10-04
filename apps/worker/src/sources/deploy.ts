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
 * Deploying a linked repository's commit on the link's targets.
 *
 * A single path, whether the decision comes from polling (`auto`), a click on
 * "Deploy this commit" (`manual`) or the approval of a pending commit
 * (`proposal`). It does what `POST /api/deployments` does, for each target: the
 * instance's scan policy applies, the preflight is authoritative on the runtime,
 * the run goes into the queue and is written to the log — with, in addition, the
 * repository, the branch and the exact commit.
 *
 * The catalog follows the repository: the application's AppSpec becomes the
 * commit's. It is the one the record shows and a next commit will compare.
 */
export type SourceDeployResult = {
  created: Array<{ id: string; number: number; targetName: string }>;
  skipped: Array<{ targetName: string; reason: string }>;
};

/**
 * Where a commit of this link goes, at this instant:
 *   targets  the link's targets;
 *   running  where the application is in service — redeploy what runs, install
 *            nothing elsewhere;
 *   none     nowhere: one deploys it by hand, wherever one wants.
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
 * The application takes a commit's version, without being deployed: its AppSpec
 * becomes the commit's, and it is its code a manual deployment will build. The
 * commit says so on GitHub.
 */
export async function syncFromSource(input: {
  source: ApplicationSourceView;
  sha: string;
  spec: AppSpec;
  trigger: 'auto' | 'manual' | 'proposal';
  /** The application was to be redeployed where it runs, but runs nowhere. */
  idle?: boolean;
  proposalId?: string | null;
  actorId: string | null;
  ip: string | null;
}): Promise<void> {
  const { source, sha, spec } = input;
  const application = await getApplication(source.applicationId);
  if (!application) throw new Error(`application "${source.applicationId}" not found`);
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
    'version taken from a repository, without deployment',
  );
}

export async function deployFromSource(input: {
  source: ApplicationSourceView;
  sha: string;
  spec: AppSpec;
  commit: SourceCommit | null;
  trigger: 'auto' | 'manual' | 'proposal';
  /** Where to deploy: `bindingsFor(source)` at decision time. */
  bindings: SourceTarget[];
  /** The approved proposal, which must not be made moot by this deployment. */
  proposalId?: string | null;
  actorId: string | null;
  ip: string | null;
}): Promise<SourceDeployResult> {
  const { source, sha, spec, commit } = input;
  const application = await getApplication(source.applicationId);
  if (!application) throw new Error(`application "${source.applicationId}" not found`);

  await updateApplication(application.id, { appSpec: spec });
  await markSourceSynced(source.id, sha);

  const settings = await getAppSettingsValue();
  // The instance's policy, then the application's own setting.
  const scanConfig = withApplicationScanPolicy(
    scanConfigFromSettings(settings.security),
    applicationScanPolicyOf(application),
  );
  const result: SourceDeployResult = { created: [], skipped: [] };
  // The repository's address at its forge: the deployment keeps it, and the link
  // to its commit follows from it — even if the link disappears afterwards.
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
    // The preflight is authoritative, as for a manually started deployment.
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
      'deployment queued from a repository',
    );
  }

  // A more recent commit just went out: the previous pending ones no longer have a
  // purpose.
  await supersedePendingProposals(source.id, input.proposalId ?? null);
  return result;
}

/** The discarded targets, in one sentence for the link. `null` if there are none. */
export function skippedSummary(result: SourceDeployResult): string | null {
  if (result.skipped.length === 0) return null;
  return result.skipped.map((entry) => `${entry.targetName} : ${entry.reason}`).join(' · ');
}
