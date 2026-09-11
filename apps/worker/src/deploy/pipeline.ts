import {
  DEPLOYMENT_STEPS,
  decrypt,
  intersectPortRanges,
  parseAppSpec,
  parseScanConfig,
  scannerLabel,
  totalFindings,
  type DeploymentStepKey,
  type PortRange,
} from '@tp/core';
import {
  getDriver,
  getProxyProvider,
  type DeployResult,
  type DriverContext,
  type RenderedArtifacts,
} from '@tp/core/drivers';
import { connect, disconnect, type SshTarget } from '@tp/core/ssh';
import {
  createPortAllocator,
  finishDeployment,
  finishStep,
  getDeploymentForRun,
  getTargetSecret,
  hasLiveDeploymentOnTarget,
  listSteps,
  logAudit,
  markDeploymentRunning,
  resetUnsuccessfulSteps,
  skipPendingSteps,
  startStep,
  type DeploymentStep,
} from '@tp/db';
import type { Redis } from 'ioredis';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { secretResolverFor } from './context.js';
import { DeployLogStream } from './log-stream.js';
import { runSecurityScan } from './scan.js';

/**
 * Exécution du pipeline de déploiement.
 *
 * Le worker ne connaît aucun runtime : il enchaîne des étapes et délègue au
 * driver. Une étape que le driver ne peut pas remplir retourne `null`, et
 * c'est **le driver** qui décide — jamais un `if (runtime === ...)` ici.
 */

export type PipelineOutcome = {
  status: 'success' | 'failed' | 'rolled_back';
  url: string | null;
  publishedPort: number | null;
  failedStep: DeploymentStepKey | null;
  error: string | null;
  /** Version vers laquelle un rollback automatique a ramené, le cas échéant. */
  rolledBackTo: string | null;
};

/** État partagé entre les étapes. */
type PipelineState = {
  artifacts: RenderedArtifacts | null;
  port: number | null;
  result: DeployResult | null;
  images: string[];
  url: string | null;
};

export async function runDeploymentPipeline(
  deploymentId: string,
  publisher: Redis,
  actor: { actorId: string | null; ip: string | null } = { actorId: null, ip: null },
): Promise<PipelineOutcome> {
  const record = await getDeploymentForRun(deploymentId);
  if (!record) throw new Error(`Déploiement « ${deploymentId} » introuvable`);

  const { deployment } = record;
  const log = logger.child({ deploymentId, runtime: deployment.runtime });
  const stream = new DeployLogStream(deploymentId, publisher);

  // Relance : ce qui a déjà réussi n'est pas rejoué, le reste repart de zéro.
  await resetUnsuccessfulSteps(deploymentId);
  await markDeploymentRunning(deploymentId);
  stream.event({ type: 'deployment', key: deploymentId, status: 'running', detail: null });

  const steps = await listSteps(deploymentId);
  const completed = new Set(
    steps.filter((step) => step.status === 'success').map((step) => step.key),
  );
  if (completed.size > 0) {
    stream.line(
      'preflight',
      `Reprise : ${completed.size} étape(s) déjà réussie(s) ne seront pas rejouées.`,
    );
  }

  const spec = parseAppSpec(deployment.appSpec);
  const secret = await getTargetSecret(deployment.targetId);
  if (!secret) throw new Error(`Cible « ${deployment.targetId} » introuvable`);

  const credential = decrypt(secret.encryptedCredential);
  const sshTarget: SshTarget = {
    host: secret.target.host,
    port: secret.target.port,
    username: secret.target.sshUser,
    sudoMethod: secret.target.sudoMethod,
    credentials:
      secret.target.authMethod === 'key'
        ? { authMethod: 'key', privateKey: credential }
        : { authMethod: 'password', password: credential },
  };

  const session = await connect(sshTarget, { logger: log });

  const previous = record.deployment.previousDeploymentId
    ? await getDeploymentForRun(record.deployment.previousDeploymentId)
    : null;

  /**
   * Plage de ports retenue : celle de la cible, resserrée par celle du worker.
   *
   * Les deux disent une vérité différente. `targets.port_range_*` décrit ce que
   * cette machine-là accepte de publier ; `DRIVER_PORT_RANGE` décrit ce que
   * l'environnement du worker peut atteindre — un tunnel, un hôte qui ne
   * republie qu'une poignée de ports. Garder l'intersection respecte les deux ;
   * garder la dernière lue en trahirait une.
   */
  const targetRange: PortRange = {
    min: secret.target.portRangeStart,
    max: secret.target.portRangeEnd,
  };
  const narrowed = intersectPortRanges(targetRange, env.DRIVER_PORT_RANGE);
  const portRange = narrowed ?? targetRange;
  const portRangeWarning =
    narrowed === null
      ? `⚠ la plage de la cible (${targetRange.min}-${targetRange.max}) et celle du worker ` +
        `(${env.DRIVER_PORT_RANGE?.min}-${env.DRIVER_PORT_RANGE?.max}) ne se recouvrent pas — ` +
        'la plage de la cible est retenue'
      : null;

  const ctx: DriverContext = {
    spec,
    target: {
      id: secret.target.id,
      name: secret.target.name,
      host: secret.target.host,
      rootPath: env.DRIVER_ROOT_PATH,
    },
    deployment: {
      id: deployment.id,
      version: spec.version,
      sequence: deployment.version,
    },
    sshSession: session,
    appSlug: spec.name,
    applicationId: deployment.applicationId,
    ...(previous
      ? {
          previousDeployment: {
            id: previous.deployment.id,
            version: parseAppSpec(previous.deployment.appSpec).version,
            sequence: previous.deployment.version,
          },
        }
      : {}),
    portAllocator: createPortAllocator(),
    portRange,
    // Les valeurs des secrets viennent du magasin de l'application, pas du
    // déploiement : elles doivent être les mêmes à chaque mise en ligne.
    resolveSecrets: secretResolverFor(deployment.applicationId),
  };

  const driver = getDriver(deployment.runtime);
  const proxy = getProxyProvider(deployment.proxy);
  const state: PipelineState = {
    artifacts: null,
    port: null,
    result: null,
    images: [],
    url: null,
  };

  /**
   * Une étape aboutit (`success`) ou est sans objet (`skipped`) — l'échec passe
   * par une exception. `skipped` vient toujours du driver ou du provider,
   * jamais d'une condition sur le runtime écrite ici.
   */
  type StepOutcome = 'success' | 'skipped';

  const handlers: Record<DeploymentStepKey, () => Promise<StepOutcome>> = {
    preflight: async () => {
      const report = await driver.preflight(ctx);
      for (const check of report.checks) {
        stream.line('preflight', `${check.ok ? '✓' : '✗'} ${check.label} — ${check.detail ?? ''}`);
      }
      if (!report.ok) throw new Error("la cible ne peut pas accueillir ce déploiement");
      return 'success';
    },

    allocate_port: async () => {
      if (portRangeWarning) stream.line('allocate_port', portRangeWarning, 'stderr');

      state.port = await driver.allocatePort(ctx, (line) => stream.line('allocate_port', line));
      if (state.port === null) {
        stream.line('allocate_port', "le runtime n'expose pas par port — étape sans objet");
        return 'skipped';
      }
      stream.line(
        'allocate_port',
        `port ${state.port} réservé dans ${portRange.min}-${portRange.max}`,
      );

      // Ouverture du pare-feu. Le worker ne demande pas quel runtime il pilote :
      // il demande si le driver sait ouvrir un port. Un driver qui n'expose pas
      // par port n'implémente pas la méthode, et l'étape se poursuit sans elle.
      if (driver.openFirewall) {
        await driver.openFirewall(ctx, state.port, (line) => stream.line('allocate_port', line));
      } else {
        stream.line('allocate_port', 'ce runtime ne gère pas de pare-feu — rien à ouvrir');
      }

      return 'success';
    },

    render: async () => {
      state.artifacts = await driver.render(ctx);
      // Une relance saute `allocate_port` si elle avait déjà réussi : le port
      // effectif vient alors du rendu, qui l'a relu.
      state.port ??= state.artifacts.publishedPort;
      for (const file of state.artifacts.files) {
        stream.line('render', `${file.path} — ${file.content.length} octets`);
      }
      return 'success';
    },

    upload: async () => {
      if (!state.artifacts) throw new Error('rien à déposer : le rendu a échoué');
      await driver.upload(ctx, state.artifacts, (line) => stream.line('upload', line));
      return 'success';
    },

    build: async () => {
      const images = await driver.build(ctx, (line) => stream.line('build', line));
      if (images === null) {
        stream.line('build', 'aucune image à construire — étape sans objet');
        return 'skipped';
      }
      state.images = images;
      return 'success';
    },

    scan: async () => {
      const config = parseScanConfig(deployment.scanConfig);
      if (config.scanners.length === 0) {
        // Deux raisons de ne rien avoir à faire, et elles ne se valent pas :
        // personne n'a demandé de scan, ou l'instance l'a coupé pour tout le
        // monde. La seconde mérite d'être lue dans le journal du déploiement.
        stream.line(
          'scan',
          config.disabledBy === 'settings'
            ? "analyse de sécurité désactivée dans les paramètres de l'instance — étape sans objet"
            : 'aucun scanner sélectionné — étape sans objet',
        );
        return 'skipped';
      }

      // Le driver sait comment il nomme ses images ; le worker, non.
      const images = await driver.images(ctx);
      const result = await runSecurityScan({
        deploymentId,
        ctx,
        config,
        images,
        onLog: (line) => stream.line('scan', line),
      });

      await logAudit({
        actorId: actor.actorId,
        action: result.blocked ? 'deployment.scan.blocked' : 'deployment.scan.passed',
        resourceType: 'deployment',
        resourceId: deploymentId,
        after: {
          scanners: config.scanners,
          failOn: config.failOn,
          images,
          counts: result.counts,
          runs: result.runs.map((run) => ({
            scanner: run.scanner,
            image: run.image,
            status: run.status,
            verdict: run.verdict,
            durationMs: run.durationMs,
            error: run.error,
          })),
          blocking: result.blocking.slice(0, 50),
          blockingTotal: result.blocking.length,
        },
        ip: actor.ip,
      });

      const total = totalFindings(result.counts);
      stream.line(
        'scan',
        `${result.runs.length} exécution(s), ${total} finding(s) — ` +
          result.runs
            .map((run) => `${scannerLabel(run.scanner)} : ${run.verdict}`)
            .join(' · '),
      );

      if (result.blocked) {
        const worst = result.blocking
          .slice(0, 5)
          .map((finding) => `${finding.cveId} (${finding.severity}, ${finding.package})`)
          .join(', ');
        throw new Error(
          `${result.blocking.length} vulnérabilité(s) au niveau ${config.failOn} ou au-dessus — ` +
            `déploiement bloqué : ${worst}${result.blocking.length > 5 ? '…' : ''}`,
        );
      }

      return 'success';
    },

    deploy: async () => {
      state.result = await driver.deploy(ctx, (line) => stream.line('deploy', line));
      state.url = state.result.url;
      state.port ??= state.result.publishedPort;
      state.images = [...new Set([...state.images, ...state.result.images])];
      return 'success';
    },

    healthcheck: async () => {
      const health = await driver.healthcheck(ctx);
      stream.line(
        'healthcheck',
        health.healthy
          ? `sain après ${health.attempts} tentative(s) — ${health.detail ?? ''}`
          : `${OUTCOME_LABEL[health.outcome]} après ${health.attempts} tentative(s) — ` +
            `${health.detail ?? 'sans détail'}`,
      );
      if (health.healthy) return 'success';

      // Le diagnostic a été capturé par le driver **avant** de rendre la main :
      // un rollback qui suit redémarre l'ancienne version et effacerait la
      // scène. On le diffuse ligne à ligne, puis on le joint au message d'échec
      // pour qu'il atterrisse dans `deployment_steps.error`.
      if (health.diagnostics) {
        for (const line of health.diagnostics.split('\n')) {
          stream.line('healthcheck', line, 'stderr');
        }
      }

      const summary = `${OUTCOME_LABEL[health.outcome]} : ${health.detail ?? 'le service ne répond pas'}`;
      throw new Error(
        health.diagnostics ? `${summary}\n\n${health.diagnostics}` : summary,
      );
    },

    /**
     * Chemin nominal : il n'y a rien à défaire, l'étape est sans objet.
     * Le rollback réel est déclenché plus bas, après le verdict de
     * `healthcheck` — une étape ne peut pas se lancer elle-même en réaction à
     * l'échec d'une autre.
     */
    rollback: async () => {
      stream.line('rollback', 'le déploiement est sain — aucun retour arrière');
      return 'skipped';
    },

    proxy: async () => {
      const registration = await proxy.register(
        ctx,
        { port: state.port, runtime: deployment.runtime },
        (line) => stream.line('proxy', line),
      );
      if (registration.url === null) {
        stream.line('proxy', registration.detail);
        return 'skipped';
      }
      state.url = registration.url;
      stream.line('proxy', registration.detail);
      return 'success';
    },
  };

  let failedStep: DeploymentStepKey | null = null;
  let failure: string | null = null;
  let finalStatus: PipelineOutcome['status'] = 'failed';
  let rolledBackTo: string | null = null;

  try {
    for (const definition of DEPLOYMENT_STEPS) {
      const key = definition.key;

      if (completed.has(key)) {
        stream.event({ type: 'step', key, status: 'success', detail: 'déjà réussie' });
        continue;
      }

      await startStep(deploymentId, key);
      stream.event({ type: 'step', key, status: 'running', detail: null });
      log.info({ step: key }, 'étape démarrée');

      try {
        const status = await handlers[key]();
        await finishStep(deploymentId, key, status);
        stream.event({ type: 'step', key, status, detail: null });
        log.info({ step: key, status }, 'étape terminée');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await finishStep(deploymentId, key, 'failed', message);
        stream.line(key, message, 'stderr');
        stream.event({ type: 'step', key, status: 'failed', detail: message });
        log.error({ step: key, err: error }, 'étape en échec');

        failedStep = key;
        failure = message;
        break;
      }
    }

    /**
     * Rollback automatique.
     *
     * Trois conditions, toutes des données : l'échec porte sur `healthcheck`,
     * la politique du déploiement l'autorise, et il existe une version
     * antérieure vers laquelle revenir. Aucune n'est un réglage global.
     *
     * Un échec ailleurs — un scan bloquant, un `deploy` qui n'a jamais démarré —
     * ne déclenche rien : il n'y a rien à défaire, la version précédente n'a
     * jamais cessé de tourner.
     */
    if (failedStep === 'healthcheck' && deployment.autoRollback && ctx.previousDeployment) {
      const restored = ctx.previousDeployment;
      await startStep(deploymentId, 'rollback');
      stream.event({ type: 'step', key: 'rollback', status: 'running', detail: null });

      try {
        stream.line(
          'rollback',
          `healthcheck en échec — retour automatique de la version ${spec.version} ` +
            `(déploiement #${deployment.version}) à la version ${restored.version} ` +
            `(déploiement #${restored.sequence})`,
        );

        await driver.rollback(ctx, (line) => stream.line('rollback', line));

        /**
         * La version restaurée doit répondre — et elle se décrit avec **sa**
         * spec, pas avec celle qui vient d'échouer.
         *
         * C'est tout l'intérêt de figer l'AppSpec dans chaque déploiement : la
         * v2 a pu déplacer sa route de santé, changer de port ou d'image. La
         * sonder avec les réglages de la v2 poserait la mauvaise question à la
         * bonne machine, et un rollback réussi passerait pour un échec.
         */
        const restoredCtx: DriverContext = {
          ...ctx,
          spec: previous ? parseAppSpec(previous.deployment.appSpec) : ctx.spec,
          deployment: {
            id: restored.id,
            version: restored.version,
            sequence: restored.sequence,
          },
        };
        const health = await driver.healthcheck(restoredCtx);
        stream.line(
          'rollback',
          health.healthy
            ? `version ${restored.version} saine après ${health.attempts} tentative(s) — ${health.detail ?? ''}`
            : `la version restaurée ne répond pas : ${health.detail ?? 'sans détail'}`,
        );
        if (!health.healthy) {
          if (health.diagnostics) {
            for (const line of health.diagnostics.split('\n')) {
              stream.line('rollback', line, 'stderr');
            }
          }
          throw new Error(
            `la version ${restored.version} a été restaurée mais ne répond pas : ` +
              `${health.detail ?? 'sans détail'}`,
          );
        }

        await finishStep(deploymentId, 'rollback', 'success');
        stream.event({
          type: 'step',
          key: 'rollback',
          status: 'success',
          detail: `version ${restored.version}`,
        });

        finalStatus = 'rolled_back';
        rolledBackTo = restored.version;
        // L'URL redevient celle de la version qui tourne réellement.
        state.url = previous?.deployment.url ?? state.url;

        await logAudit({
          actorId: actor.actorId,
          action: 'deployment.rolled_back.automatic',
          resourceType: 'deployment',
          resourceId: deploymentId,
          before: { version: spec.version, sequence: deployment.version, status: 'failed' },
          after: {
            restoredVersion: restored.version,
            restoredDeploymentId: restored.id,
            restoredSequence: restored.sequence,
            reason: failure,
            failedStep,
            url: state.url,
            publishedPort: state.port,
          },
          ip: actor.ip,
        });

        log.warn(
          { from: spec.version, to: restored.version },
          'rollback automatique effectué',
        );
      } catch (error) {
        // **Jamais de second rollback.** Un rollback qui échoue signale un
        // problème que rejouer la même commande ne réglera pas, et enchaîner
        // les tentatives ne ferait qu'éloigner la machine d'un état connu.
        const message = error instanceof Error ? error.message : String(error);
        await finishStep(deploymentId, 'rollback', 'failed', message);
        stream.line('rollback', message, 'stderr');
        stream.event({ type: 'step', key: 'rollback', status: 'failed', detail: message });

        failure = `${failure ?? 'healthcheck en échec'} — le rollback automatique a échoué : ${message}`;
        log.error({ err: error }, 'rollback automatique en échec');

        await logAudit({
          actorId: actor.actorId,
          action: 'deployment.rollback.failed',
          resourceType: 'deployment',
          resourceId: deploymentId,
          after: {
            attemptedVersion: restored.version,
            attemptedDeploymentId: restored.id,
            error: message,
            automatic: true,
          },
          ip: actor.ip,
        });
      }
    }

    if (failedStep) {
      const skipped = await skipPendingSteps(deploymentId);
      for (const key of skipped) {
        stream.event({ type: 'step', key, status: 'skipped', detail: 'étape non atteinte' });
      }
    }

    if (finalStatus !== 'rolled_back') finalStatus = failedStep ? 'failed' : 'success';

    await finishDeployment(deploymentId, finalStatus, {
      url: state.url,
      publishedPort: state.port,
      imageTag: state.images[0] ?? null,
      failedStep,
      error: failure,
    });
    stream.event({
      type: 'deployment',
      key: deploymentId,
      status: finalStatus,
      detail: finalStatus === 'rolled_back' ? `version ${rolledBackTo}` : state.url,
    });

    return {
      status: finalStatus,
      url: state.url,
      publishedPort: state.port,
      failedStep,
      error: failure,
      rolledBackTo,
    };
  } finally {
    // Un port réservé pour un déploiement qui n'a rien démarré est un port
    // perdu : personne ne le libérera jamais, et la plage d'une cible n'est pas
    // extensible. Le `finally` couvre aussi le crash — une exception hors
    // pipeline ne doit pas laisser de trace derrière elle.
    await releaseOrphanPort({
      status: finalStatus,
      deployment,
      ctx,
      driver,
      stream,
      log,
    });

    await stream.close();
    await disconnect(session);
  }
}

/**
 * Libère la réservation de port si plus rien ne l'occupe.
 *
 * La condition n'est pas « le déploiement a échoué » mais « aucune version de
 * cette application ne tourne sur cette cible ». Le verdict vient de
 * `hasLiveDeploymentOnTarget()`, c'est-à-dire de l'unique définition de
 * « vivant » portée par `@tp/db` — le worker n'en a pas une à lui.
 *
 * Le déploiement qui vient d'échouer entre dans le calcul au lieu d'en être
 * exclu : s'il a dépassé l'étape `deploy`, ce sont ses propres conteneurs qui
 * occupent le port. Un échec plus tôt — préflight, rendu, build, scan — n'a rien
 * démarré, et la réservation part.
 */
async function releaseOrphanPort(input: {
  status: PipelineOutcome['status'];
  deployment: { id: string; applicationId: string; targetId: string };
  ctx: DriverContext;
  driver: ReturnType<typeof getDriver>;
  stream: DeployLogStream;
  log: typeof logger;
}): Promise<void> {
  const { status, deployment, ctx, driver, stream, log } = input;
  if (status === 'success' || status === 'rolled_back') return;
  if (!ctx.portAllocator) return;

  try {
    const key = { targetId: deployment.targetId, applicationId: deployment.applicationId };
    const port = await ctx.portAllocator.current(key);
    if (port === null) return;

    const live = await hasLiveDeploymentOnTarget(
      deployment.applicationId,
      deployment.targetId,
    );
    if (live) {
      stream.line('allocate_port', `port ${port} conservé : une version tourne encore sur la cible`);
      return;
    }

    if (driver.closeFirewall) {
      await driver.closeFirewall(ctx, port, (line) => stream.line('allocate_port', line));
    }
    await ctx.portAllocator.release(key);
    stream.line('allocate_port', `port ${port} libéré : le déploiement n'a rien laissé derrière lui`);
    log.info({ port }, 'port libéré après échec');
  } catch (error) {
    // Le ménage ne doit jamais masquer la cause réelle de l'échec.
    log.error({ err: error }, 'libération du port impossible');
  }
}

/** Libellés des trois issues d'une sonde de santé. */
const OUTCOME_LABEL: Record<'healthy' | 'unhealthy' | 'unreachable', string> = {
  healthy: 'sain',
  unhealthy: 'répond mais en erreur',
  unreachable: 'injoignable',
};

/** Étapes restantes après un point d'arrêt, pour l'affichage. */
export function remainingSteps(steps: DeploymentStep[]): DeploymentStep[] {
  return steps.filter((step) => step.status === 'pending');
}
