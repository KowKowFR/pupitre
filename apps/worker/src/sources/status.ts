import { languageOf, renderMessage, type Translated, type UiLanguage } from '@pupitre/core';
import type { CommitStatus } from '@pupitre/core/sources';
import {
  getAppSettingsValue,
  getApplicationSource,
  getDeploymentForRun,
  getDeploymentSummary,
} from '@pupitre/db';
import { logger } from '../logger.js';
import { providerForConnection } from './provider.js';

/**
 * Ce que Pupitre écrit sur un commit — GitHub ou Gitea : l'état de son déploiement, cible
 * par cible (`pupitre/prod-1`), ou le sort réservé au commit (`pupitre`).
 *
 * Écrit dans la langue de l'instance, comme les alertes : c'est l'équipe qui
 * lit ces statuts, dans l'onglet du commit. Un statut qui ne part pas ne fait
 * jamais échouer un déploiement — c'est une information, pas une étape.
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

export async function statusLanguage(): Promise<UiLanguage> {
  return languageOf((await getAppSettingsValue()).locale);
}

export function statusText(
  language: UiLanguage,
  key: keyof typeof fr,
  vars: Record<string, string | number> = {},
): string {
  return renderMessage(STATUS_TEXT, language, key, vars);
}

/** L'URL du panel, pour le lien du statut. Absente : un statut sans lien. */
export function panelUrl(): string | null {
  const raw = process.env.BETTER_AUTH_URL?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/** Le dépôt d'une liaison, par la connexion qui l'ouvre. */
export type LinkedRepository = {
  connectionId: string;
  repository: string;
  installationId: number | null;
};

/**
 * Publie un statut sur le commit, chez le fournisseur de la liaison, sans
 * jamais lever : l'échec se dit dans les logs du worker.
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
      'statut de commit non publié',
    );
  }
}

/**
 * L'état d'un run, renvoyé sur le commit qui l'a déclenché. Sans liaison (le
 * run ne vient pas d'un dépôt, ou la liaison a été supprimée), rien à dire.
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
    logger.warn({ err: error, deploymentId }, 'statut de déploiement non publié');
  }
}
