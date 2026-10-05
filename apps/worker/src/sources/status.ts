import { renderMessage, type Translated, type UiLanguage } from '@pupitre/core';
import type { CommitStatus } from '@pupitre/core/sources';
import { getApplicationSource, getDeploymentForRun, getDeploymentSummary } from '@pupitre/db';
import { instanceLanguage } from '../language.js';
import { logger } from '../logger.js';
import { providerForConnection } from './provider.js';

/**
 * What Pupitre writes on a commit — GitHub, GitLab or Gitea: its deployment's
 * state, target by target (`pupitre/prod-1`), or the fate given to the commit
 * (`pupitre`).
 *
 * Written in the instance's language, like the alerts: it is the team that reads
 * these statuses, in the commit's tab. A status that does not go out never fails
 * a deployment — it is information, not a step.
 */
const fr = {
  pending: 'Déploiement #{number} en cours sur {target}',
  success: 'Déployé sur {target} — run #{number}',
  failed: 'Échec sur {target} à l’étape {step} — run #{number}',
  'failed.nostep': 'Échec sur {target} — run #{number}',
  rolledBack: 'Replié sur {target} : la version précédente tourne — run #{number}',
  proposal: 'En attente de validation dans Pupitre',
  invalid: 'pupitre.json refusé : {issue}',
  synced: 'Version prise en compte par Pupitre — à déployer depuis le panel',
  'synced.idle': 'Version prise en compte par Pupitre — l’application ne tourne nulle part',
} as const;

const en: Translated<typeof fr> = {
  pending: 'Deployment #{number} running on {target}',
  success: 'Deployed to {target} — run #{number}',
  failed: 'Failed on {target} at step {step} — run #{number}',
  'failed.nostep': 'Failed on {target} — run #{number}',
  rolledBack: 'Rolled back on {target}: the previous version is running — run #{number}',
  proposal: 'Awaiting approval in Pupitre',
  invalid: 'pupitre.json rejected: {issue}',
  synced: 'Version taken into Pupitre — deploy it from the panel',
  'synced.idle': 'Version taken into Pupitre — the application is not running anywhere',
};

const STATUS_TEXT = { fr, en };

/** The instance's language — see `instanceLanguage()`. */
export const statusLanguage = instanceLanguage;

export function statusText(
  language: UiLanguage,
  key: keyof typeof fr,
  vars: Record<string, string | number> = {},
): string {
  return renderMessage(STATUS_TEXT, language, key, vars);
}

/** The panel's URL, for the status's link. Absent: a status without a link. */
export function panelUrl(): string | null {
  const raw = process.env.BETTER_AUTH_URL?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/** A link's repository, through the connection that opens it. */
export type LinkedRepository = {
  connectionId: string;
  repository: string;
  installationId: number | null;
};

/**
 * Publishes a status on the commit, at the link's provider, without ever
 * throwing: the failure is told in the worker's logs.
 */
export async function reportCommitStatus(
  source: LinkedRepository,
  sha: string,
  status: CommitStatus,
): Promise<void> {
  try {
    const access = await providerForConnection(source.connectionId);
    if (!access) return;
    await access.provider.reportStatus(
      { fullName: source.repository, installationId: source.installationId },
      sha,
      status,
    );
  } catch (error) {
    logger.warn(
      { err: error, repository: source.repository, sha, context: status.context },
      'commit status not published',
    );
  }
}

/**
 * A run's state, sent back on the commit that triggered it. Without a link (the
 * run does not come from a repository, or the link was deleted), nothing to say.
 */
export async function reportDeploymentStatus(
  deploymentId: string,
  outcome: 'pending' | 'success' | 'failed' | 'rolled_back',
  failedStep: string | null = null,
): Promise<void> {
  try {
    const [run, summary] = await Promise.all([
      getDeploymentForRun(deploymentId),
      getDeploymentSummary(deploymentId),
    ]);
    const deployment = run?.deployment;
    if (!deployment?.sourceId || !deployment.sourceSha || !summary) return;
    const source = await getApplicationSource(deployment.sourceId);
    if (!source) return;

    const language = await statusLanguage();
    const vars = { number: summary.number, target: summary.targetName, step: failedStep ?? '' };
    const base = panelUrl();
    await reportCommitStatus(source, deployment.sourceSha, {
      state: outcome === 'pending' ? 'pending' : outcome === 'success' ? 'success' : 'failure',
      description:
        outcome === 'pending'
          ? statusText(language, 'pending', vars)
          : outcome === 'success'
            ? statusText(language, 'success', vars)
            : outcome === 'rolled_back'
              ? statusText(language, 'rolledBack', vars)
              : statusText(language, failedStep ? 'failed' : 'failed.nostep', vars),
      context: `pupitre/${summary.targetName}`,
      targetUrl: base ? `${base}/deployments/${deploymentId}` : null,
    });
  } catch (error) {
    logger.warn({ err: error, deploymentId }, 'deployment status not published');
  }
}
