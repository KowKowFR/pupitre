import 'server-only';
import {
  STUCK_DEPLOYMENT_GRACE_MS,
  UNFINISHED_JOB_STATES,
  jobMayAdvanceDeployment,
  type UnfinishedJobState,
} from '@pupitre/core';
import { listUnfinishedDeployments, type UnfinishedDeployment } from '@pupitre/db';
import type { Queue } from 'bullmq';
import { deployments } from '@/i18n/messages/deployments';
import { msg, type MessageRef } from '@/lib/errors';

/**
 * Verdict sur un déploiement que la base croit en cours.
 *
 * La règle vit dans `@pupitre/core` (`UNFINISHED_JOB_STATES`,
 * `jobMayAdvanceDeployment`) ; ce module n'est que la glue qui va la lire dans
 * Redis. `@pupitre/core` ne dépend pas de `bullmq` — il décrit le contrat des files,
 * il n'en ouvre aucune — et c'est cette séparation qui permet au worker
 * d'appliquer exactement la même règle sans que la décision soit écrite deux
 * fois.
 */
export type StuckVerdict = {
  deployment: UnfinishedDeployment;
  /**
   * Plus aucune tâche exécutable ne porte ce déploiement : c'est un fantôme
   * avéré, pas une supposition.
   */
  ghost: boolean;
  /** La tâche qui peut encore agir, quand il y en a une — c'est elle qui innocente. */
  job: { id: string; name: string; state: UnfinishedJobState } | null;
  /** Âge de la ligne. Sert au diagnostic, jamais au verdict. */
  ageMs: number;
  /** Dans la fenêtre de grâce de l'enfilage : on ne conclut pas encore. */
  tooRecent: boolean;
};

type LiveJob = { id: string; name: string; data: unknown; state: UnfinishedJobState };

/**
 * Toutes les tâches de la file `ops` encore susceptibles de s'exécuter.
 *
 * Lues état par état — et non d'un bloc — parce que le verdict doit pouvoir
 * **nommer** l'état qui innocente le déploiement : « votre tâche est active
 * depuis quatre minutes » est une réponse, « elle existe » n'en est pas une.
 *
 * Le volume est borné par nature : ces états ne contiennent que ce qui reste à
 * faire. Les milliers de tâches terminées, elles, ne sont jamais parcourues.
 */
async function listLiveJobs(queue: Queue): Promise<LiveJob[]> {
  const perState = await Promise.all(
    UNFINISHED_JOB_STATES.map(async (state) => {
      const jobs = await queue.getJobs([state]);
      return jobs
        .filter((job): job is typeof job & { id: string } => typeof job.id === 'string')
        .map((job) => ({ id: job.id, name: job.name, data: job.data as unknown, state }));
    }),
  );
  return perState.flat();
}

function verdictFor(
  deployment: UnfinishedDeployment,
  live: readonly LiveJob[],
  now: number,
): StuckVerdict {
  const ageMs = now - deployment.createdAt.getTime();
  const tooRecent = ageMs < STUCK_DEPLOYMENT_GRACE_MS;

  const job =
    live.find((candidate) =>
      jobMayAdvanceDeployment(candidate, {
        deploymentId: deployment.id,
        applicationId: deployment.applicationId,
      }),
    ) ?? null;

  return {
    deployment,
    ghost: job === null && !tooRecent,
    job: job ? { id: job.id, name: job.name, state: job.state } : null,
    ageMs,
    tooRecent,
  };
}

/** Tout ce que la base croit en cours, avec le verdict de chacun. */
export async function inspectUnfinishedDeployments(queue: Queue): Promise<StuckVerdict[]> {
  const unfinished = await listUnfinishedDeployments();
  if (unfinished.length === 0) return [];

  const live = await listLiveJobs(queue);
  const now = Date.now();
  return unfinished.map((deployment) => verdictFor(deployment, live, now));
}

/**
 * Le verdict d'un seul déploiement. `null` quand il n'est plus « en cours » —
 * il s'est conclu, ou il n'existe pas.
 */
export async function inspectDeployment(
  queue: Queue,
  deploymentId: string,
): Promise<StuckVerdict | null> {
  const unfinished = await listUnfinishedDeployments();
  const deployment = unfinished.find((row) => row.id === deploymentId);
  if (!deployment) return null;

  return verdictFor(deployment, await listLiveJobs(queue), Date.now());
}

/**
 * Pourquoi on refuse de déclarer ce déploiement figé.
 *
 * Une **référence** et non une phrase : la fonction est synchrone et n'a aucun
 * moyen d'aller lire la langue de l'instance. C'est `apiRoute()` qui rendra le
 * texte, comme pour toutes les erreurs du panel.
 */
export function refusalMessage(verdict: StuckVerdict): MessageRef {
  if (verdict.job) {
    return msg(deployments, 'unblock.refusal.job', {
      name: verdict.job.name,
      id: verdict.job.id,
      state: verdict.job.state,
      count: Math.max(1, Math.round(verdict.ageMs / 60_000)),
    });
  }

  return msg(deployments, 'unblock.refusal.tooRecent', {
    seconds: Math.round(verdict.ageMs / 1000),
  });
}
