import { deployChannel, deploymentJobDataSchema, type DeploymentJobResult } from '@pupitre/core';
import { getDriver, getProxyProvider } from '@pupitre/core/drivers';
import { disconnect, type ConnectOptions } from '@pupitre/core/ssh';
import { finishDeployment, logAudit } from '@pupitre/db';
import type { Job } from 'bullmq';
import { logger } from '../logger.js';
import { openDeploymentContext } from '../deploy/context.js';
import { DeployLogStream } from '../deploy/log-stream.js';
import { runDeploymentPipeline } from '../deploy/pipeline.js';
import { getPublisher } from '../redis.js';

/**
 * Verdict du pipeline → action d'audit. Une table, pas une chaîne de ternaires :
 * un quatrième verdict s'ajouterait ici et nulle part ailleurs.
 *
 * `deployment.rolled_back` dit **où en est** le déploiement. C'est une entrée
 * distincte de `deployment.rolled_back.automatic`, écrite par le pipeline, qui
 * dit **pourquoi** et **vers quoi** — deux questions, deux traces. Les
 * confondre sous un même nom donnerait deux charges utiles différentes pour une
 * même action, et rendrait le journal illisible à la requête.
 */
const DEPLOYMENT_AUDIT_ACTION = {
  success: 'deployment.succeeded',
  failed: 'deployment.failed',
  rolled_back: 'deployment.rolled_back',
} as const;

/** Déploiement complet : le pipeline, étape par étape. */
export async function handleDeploymentRun(
  job: Job<unknown, DeploymentJobResult>,
): Promise<DeploymentJobResult> {
  const data = deploymentJobDataSchema.parse(job.data);
  const log = logger.child({ jobId: job.id, deploymentId: data.deploymentId });

  log.info('pipeline de déploiement démarré');

  try {
    const outcome = await runDeploymentPipeline(data.deploymentId, getPublisher(), {
      actorId: data.actorId,
      ip: data.ip,
    });

    await logAudit({
      actorId: data.actorId,
      action: DEPLOYMENT_AUDIT_ACTION[outcome.status],
      resourceType: 'deployment',
      resourceId: data.deploymentId,
      after: {
        status: outcome.status,
        url: outcome.url,
        publishedPort: outcome.publishedPort,
        failedStep: outcome.failedStep,
        error: outcome.error,
        rolledBackTo: outcome.rolledBackTo,
        automatic: outcome.status === 'rolled_back',
      },
      ip: data.ip,
    });

    log.info({ status: outcome.status, url: outcome.url }, 'pipeline terminé');

    return {
      deploymentId: data.deploymentId,
      status: outcome.status,
      url: outcome.url,
      failedStep: outcome.failedStep,
    };
  } catch (error) {
    // Échec hors pipeline : cible introuvable, SSH impossible, AppSpec illisible.
    const message = error instanceof Error ? error.message : String(error);
    log.error({ err: error }, 'pipeline interrompu avant son terme');

    await finishDeployment(data.deploymentId, 'failed', { error: message });
    getPublisher()
      .publish(
        deployChannel(data.deploymentId),
        JSON.stringify({
          kind: 'event',
          payload: {
            ts: new Date().toISOString(),
            type: 'deployment',
            key: data.deploymentId,
            status: 'failed',
            detail: message,
          },
        }),
      )
      .catch(() => {});

    await logAudit({
      actorId: data.actorId,
      action: 'deployment.failed',
      resourceType: 'deployment',
      resourceId: data.deploymentId,
      after: { error: message },
      ip: data.ip,
    });

    throw error;
  }
}

/** Retour à la version précédente. */
export async function handleDeploymentRollback(
  job: Job<unknown, DeploymentJobResult>,
): Promise<DeploymentJobResult> {
  const data = deploymentJobDataSchema.parse(job.data);
  const log = logger.child({ jobId: job.id, deploymentId: data.deploymentId });

  const { session, ctx, deployment } = await openDeploymentContext(data.deploymentId);
  const stream = new DeployLogStream(data.deploymentId, getPublisher());

  try {
    if (!ctx.previousDeployment) {
      throw new Error("aucun déploiement précédent vers lequel revenir");
    }

    stream.event({ type: 'deployment', key: data.deploymentId, status: 'running', detail: null });
    const driver = getDriver(deployment.runtime);
    await driver.rollback(ctx, (line) => stream.line('deploy', line));

    // Contrôle informatif : un rollback demandé à la main reste un rollback
    // réussi même si l'ancienne version boite. C'est l'opérateur qui décide de
    // la suite, on lui donne l'information plutôt qu'un statut de plus.
    const health = await driver.healthcheck(ctx);
    stream.line(
      'deploy',
      health.healthy
        ? `version ${ctx.previousDeployment.version} saine — ${health.detail ?? ''}`
        : `⚠ la version restaurée ne répond pas : ${health.detail ?? 'sans détail'}`,
    );

    await finishDeployment(data.deploymentId, 'rolled_back', {
      error: null,
      failedStep: null,
    });
    stream.event({
      type: 'deployment',
      key: data.deploymentId,
      status: 'rolled_back',
      detail: `version ${ctx.previousDeployment.version}`,
    });

    await logAudit({
      actorId: data.actorId,
      action: 'deployment.rolled_back',
      resourceType: 'deployment',
      resourceId: data.deploymentId,
      after: {
        to: ctx.previousDeployment.version,
        toDeploymentId: ctx.previousDeployment.id,
        automatic: false,
        healthy: health.healthy,
      },
      ip: data.ip,
    });

    log.info({ to: ctx.previousDeployment.version }, 'rollback effectué');

    return {
      deploymentId: data.deploymentId,
      status: 'rolled_back',
      url: null,
      failedStep: null,
    };
  } finally {
    await stream.close();
    await disconnect(session);
  }
}

export type DestroyOptions = {
  actorId: string | null;
  ip: string | null;
  /** Borne la tentative d'ouverture de session. Défaut : celui du SSH. */
  connect?: ConnectOptions;
};

/**
 * Destruction : compose down, répertoire supprimé, port libéré, proxy retiré.
 *
 * Extraite du handler pour que la suppression en cascade d'une application
 * l'appelle telle quelle, déploiement par déploiement. Composer plutôt que
 * réécrire : le jour où la destruction apprend un geste de plus — retirer une
 * entrée DNS, prévenir un proxy —, la cascade l'apprend sans qu'on y touche.
 *
 * Elle **throw** quand la cible est injoignable, et c'est le contrat : c'est à
 * l'appelant de décider si un échec est fatal ou s'il se rapporte.
 */
export async function destroyDeployment(
  deploymentId: string,
  options: DestroyOptions,
): Promise<void> {
  const { session, ctx, deployment } = await openDeploymentContext(deploymentId, {
    ...(options.connect ? { connect: options.connect } : {}),
  });
  const stream = new DeployLogStream(deploymentId, getPublisher());

  try {
    await getProxyProvider(deployment.proxy).unregister(ctx, (line) =>
      stream.line('proxy', line),
    );
    await getDriver(deployment.runtime).destroy(ctx, (line) => stream.line('deploy', line));

    await finishDeployment(deploymentId, 'destroyed', { url: null, publishedPort: null });
    stream.event({
      type: 'deployment',
      key: deploymentId,
      status: 'destroyed',
      detail: null,
    });

    await logAudit({
      actorId: options.actorId,
      action: 'deployment.destroyed',
      resourceType: 'deployment',
      resourceId: deploymentId,
      ip: options.ip,
    });
  } finally {
    await stream.close();
    await disconnect(session);
  }
}

/** Destruction unitaire, déclenchée depuis `DELETE /api/deployments/:id`. */
export async function handleDeploymentDestroy(
  job: Job<unknown, DeploymentJobResult>,
): Promise<DeploymentJobResult> {
  const data = deploymentJobDataSchema.parse(job.data);
  const log = logger.child({ jobId: job.id, deploymentId: data.deploymentId });

  await destroyDeployment(data.deploymentId, { actorId: data.actorId, ip: data.ip });
  log.info('déploiement détruit');

  return { deploymentId: data.deploymentId, status: 'destroyed', url: null, failedStep: null };
}
