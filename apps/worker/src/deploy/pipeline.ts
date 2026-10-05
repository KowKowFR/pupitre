import {
  DEPLOYMENT_STEPS,
  intersectPortRanges,
  parseAppSpec,
  parseScanConfig,
  scannerLabel,
  totalFindings,
  type DeploymentStepKey,
  type PortRange,
} from '@pupitre/core';
import {
  getDriver,
  type DeployResult,
  type DriverContext,
  type RenderedArtifacts,
} from '@pupitre/core/drivers';
import { connect, disconnect } from '@pupitre/core/ssh';
import {
  createPortAllocator,
  finishDeployment,
  finishStep,
  getBackupPolicy,
  getDeploymentForRun,
  getTargetSecret,
  hasLiveDeploymentOnTarget,
  listLiveDeployments,
  listSteps,
  logAudit,
  markDeploymentRunning,
  resetUnsuccessfulSteps,
  skipPendingSteps,
  startStep,
} from '@pupitre/db';
import type { Redis } from 'ioredis';
import { env } from '../env.js';
import { carriesSourceCode, prepareSourceArchive } from '../sources/archive.js';
import { instanceLanguage } from '../language.js';
import { logger } from '../logger.js';
import { workerSay } from '../messages.js';
import { secretResolverFor } from './context.js';
import { DeployLogStream } from './log-stream.js';
import { runSecurityScan } from './scan.js';
import { sshTargetOf } from './ssh-target.js';
import { backupApplication } from '../backup/application.js';
import { verifyLinkBeforeDeploy } from '../proxy/link.js';
import { applyCoupleRoutes, exposureFor, seedRouteFromSpec } from '../proxy/routes.js';

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
  // La langue de tout ce que ce déploiement écrira : son journal, ses erreurs.
  const language = await instanceLanguage();
  const say = workerSay(language);

  const record = await getDeploymentForRun(deploymentId);
  if (!record) throw new Error(say('notFound.deployment', { id: deploymentId }));

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
    stream.line('preflight', say('pipeline.resume', { count: completed.size }));
  }

  const spec = parseAppSpec(deployment.appSpec);
  const secret = await getTargetSecret(deployment.targetId);
  if (!secret) throw new Error(say('notFound.target', { id: deployment.targetId }));

  const session = await connect(sshTargetOf(secret), { logger: log, language });

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
      ? say('pipeline.portRangesDisjoint', {
          targetMin: targetRange.min,
          targetMax: targetRange.max,
          workerMin: env.DRIVER_PORT_RANGE?.min ?? '?',
          workerMax: env.DRIVER_PORT_RANGE?.max ?? '?',
        })
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
    language,
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
    // Le code d'un dépôt ira dans `source/` de la release : le rendu doit le
    // savoir pour y résoudre les contextes de construction.
    ...(carriesSourceCode(deployment, spec) ? { sourceInRelease: true } : {}),
  };

  const driver = getDriver(deployment.runtime);

  // Les domaines d'abord, parce qu'ils décident de la publication du port :
  // celui de l'AppSpec au premier déploiement sur cette cible, puis la liste de
  // la cible. Un proxy de la machine la joint par la boucle locale ; celui
  // d'une autre, par un port publié sur l'adresse privée qu'il joint, ouvert à
  // lui seul. Dans les deux cas, le port n'est plus ouvert au monde.
  if (!ctx.previousDeployment) {
    await seedRouteFromSpec(deployment.applicationId, deployment.targetId, spec, (line) =>
      stream.line('preflight', line),
    );
  }
  const exposure = await exposureFor(deployment.applicationId, deployment.targetId);
  if (exposure) ctx.exposure = exposure;
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
      if (!report.ok) throw new Error(say('pipeline.preflightRefused'));

      // Servie par le proxy d'une autre machine : la connexion de l'une à
      // l'autre est éprouvée avant de rien construire, sur la plage où le port
      // sera publié. L'adresse d'arrivée relevée devient celle à qui l'ouvrir.
      const linked = await verifyLinkBeforeDeploy({
        applicationId: deployment.applicationId,
        targetId: deployment.targetId,
        served: ctx,
        portRange,
        onLog: (line) => stream.line('preflight', line),
      });
      if (linked) {
        const refreshed = await exposureFor(deployment.applicationId, deployment.targetId);
        if (refreshed) ctx.exposure = refreshed;
      }
      return 'success';
    },

    allocate_port: async () => {
      if (portRangeWarning) stream.line('allocate_port', portRangeWarning, 'stderr');

      state.port = await driver.allocatePort(ctx, (line) => stream.line('allocate_port', line));
      if (state.port === null) {
        stream.line('allocate_port', say('pipeline.port.notByPort'));
        return 'skipped';
      }
      stream.line(
        'allocate_port',
        say('pipeline.port.reserved', { port: state.port, min: portRange.min, max: portRange.max }),
      );

      // Ouverture du pare-feu. Le worker ne demande pas quel runtime il pilote :
      // il demande si le driver sait ouvrir un port. Un driver qui n'expose pas
      // par port n'implémente pas la méthode, et l'étape se poursuit sans elle.
      if (driver.openFirewall) {
        await driver.openFirewall(ctx, state.port, (line) => stream.line('allocate_port', line));
      } else {
        stream.line('allocate_port', say('pipeline.firewall.none'));
      }

      return 'success';
    },

    render: async () => {
      state.artifacts = await driver.render(ctx);
      // Une relance saute `allocate_port` si elle avait déjà réussi : le port
      // effectif vient alors du rendu, qui l'a relu.
      state.port ??= state.artifacts.publishedPort;
      for (const file of state.artifacts.files) {
        stream.line(
          'render',
          say('pipeline.render.file', { path: file.path, bytes: file.content.length }),
        );
      }
      return 'success';
    },

    upload: async () => {
      if (!state.artifacts) throw new Error(say('pipeline.upload.nothing'));
      // Un run venu d'un dépôt lié apporte le code de son commit : l'archive
      // est téléchargée ici, passée au driver, puis effacée du worker.
      const source = await prepareSourceArchive(
        deployment,
        spec,
        (line) => stream.line('upload', line),
        language,
      );
      try {
        await driver.upload(
          source ? { ...ctx, sourceArchive: source.archive } : ctx,
          state.artifacts,
          (line) => stream.line('upload', line),
        );
      } finally {
        await source?.cleanup();
      }
      return 'success';
    },

    build: async () => {
      const images = await driver.build(ctx, (line) => stream.line('build', line));
      if (images === null) {
        stream.line('build', say('pipeline.build.none'));
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
            ? say('pipeline.scan.disabled')
            : say('pipeline.scan.none'),
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
        store: driver.imageStore(ctx),
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
          onlyFixable: config.onlyFixable ?? false,
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
        say('pipeline.scan.summary', {
          runs: result.runs.length,
          findings: total,
          verdicts: result.runs
            .map((run) =>
              say('pipeline.scan.verdict', {
                scanner: scannerLabel(run.scanner),
                verdict: run.verdict,
              }),
            )
            .join(' · '),
        }),
      );

      if (result.blocked) {
        const worst = result.blocking
          .slice(0, 5)
          .map((finding) => `${finding.cveId} (${finding.severity}, ${finding.package})`)
          .join(', ');
        throw new Error(
          say('pipeline.scan.blocked', {
            count: result.blocking.length,
            failOn: config.failOn,
            worst: `${worst}${result.blocking.length > 5 ? '…' : ''}`,
          }),
        );
      }

      return 'success';
    },

    /**
     * La sauvegarde avant déploiement — ou avant une mise à jour d'image, qui
     * est un redéploiement. Elle sauvegarde ce qui tourne **encore**, juste
     * avant qu'on le remplace : après le build et l'analyse, pour ne rien
     * sauvegarder d'un déploiement qui n'aurait pas eu lieu.
     *
     * Si elle échoue, le déploiement s'arrête là : c'est le sens même de
     * l'option. Rien n'a encore changé sur la cible.
     */
    backup: async () => {
      const policy = await getBackupPolicy(deployment.applicationId);
      if (!policy.beforeDeploy) {
        stream.line('backup', say('pipeline.backup.notRequested'));
        return 'skipped';
      }
      const [live] = await listLiveDeployments({
        applicationId: deployment.applicationId,
        targetId: deployment.targetId,
      });
      if (!live?.inService || live.inService.id === deployment.id) {
        stream.line('backup', say('pipeline.backup.firstDeploy'));
        return 'skipped';
      }
      const result = await backupApplication({
        applicationId: deployment.applicationId,
        targetId: deployment.targetId,
        trigger: 'pre_deploy',
        mode: policy.mode,
        actorId: actor.actorId,
        ip: actor.ip,
        onLog: (line) => stream.line('backup', line),
      });
      if (result.status === 'failed') {
        throw new Error(say('pipeline.backup.failed', { error: result.error }));
      }
      if (result.status === 'skipped') {
        stream.line('backup', say('pipeline.backup.skipped', { reason: result.reason }));
        return 'skipped';
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
          ? say('pipeline.health.ok', { count: health.attempts, detail: health.detail ?? '' })
          : say('pipeline.health.failed', {
              outcome: say(`outcome.${health.outcome}`),
              count: health.attempts,
              detail: health.detail ?? say('noDetail'),
            }),
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

      const summary = say('pipeline.health.summary', {
        outcome: say(`outcome.${health.outcome}`),
        detail: health.detail ?? say('pipeline.health.noAnswer'),
      });
      throw new Error(health.diagnostics ? `${summary}\n\n${health.diagnostics}` : summary);
    },

    /**
     * Chemin nominal : il n'y a rien à défaire, l'étape est sans objet.
     * Le rollback réel est déclenché plus bas, après le verdict de
     * `healthcheck` — une étape ne peut pas se lancer elle-même en réaction à
     * l'échec d'une autre.
     */
    rollback: async () => {
      stream.line('rollback', say('pipeline.rollback.notNeeded'));
      return 'skipped';
    },

    proxy: async () => {
      const applied = await applyCoupleRoutes({
        applicationId: deployment.applicationId,
        targetId: deployment.targetId,
        driver,
        ctx,
        publishedPort: state.port,
        onLog: (line) => stream.line('proxy', line),
      });
      if (applied.skipped) {
        stream.line('proxy', applied.skipped);
        return 'skipped';
      }
      state.url = applied.url;
      // Un domaine qui ne répond pas n'annule pas un déploiement sain : la
      // nouvelle version tourne. La route est notée en échec, la sonde
      // périodique prévient, et le journal de l'étape dit pourquoi.
      for (const problem of applied.problems) stream.line('proxy', `⚠ ${problem}`, 'stderr');
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
        stream.event({
          type: 'step',
          key,
          status: 'success',
          detail: say('pipeline.step.alreadyDone'),
        });
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
          say('pipeline.rollback.auto', {
            from: spec.version,
            fromSequence: deployment.version,
            to: restored.version,
            toSequence: restored.sequence,
          }),
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
            ? say('pipeline.rollback.healthy', {
                version: restored.version,
                count: health.attempts,
                detail: health.detail ?? '',
              })
            : say('pipeline.rollback.restoredDown', { detail: health.detail ?? say('noDetail') }),
        );
        if (!health.healthy) {
          if (health.diagnostics) {
            for (const line of health.diagnostics.split('\n')) {
              stream.line('rollback', line, 'stderr');
            }
          }
          throw new Error(
            say('pipeline.rollback.restoredButDown', {
              version: restored.version,
              detail: health.detail ?? say('noDetail'),
            }),
          );
        }

        await finishStep(deploymentId, 'rollback', 'success');
        stream.event({
          type: 'step',
          key: 'rollback',
          status: 'success',
          detail: say('version', { version: restored.version }),
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

        failure = say('pipeline.rollback.failed', {
          failure: failure ?? say('pipeline.healthcheckFailed'),
          error: message,
        });
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
        stream.event({
          type: 'step',
          key,
          status: 'skipped',
          detail: say('pipeline.step.notReached'),
        });
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
      detail:
        finalStatus === 'rolled_back'
          ? say('version', { version: rolledBackTo ?? '?' })
          : state.url,
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
 * « vivant » portée par `@pupitre/db` — le worker n'en a pas une à lui.
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
      stream.line('allocate_port', workerSay(ctx.language)('pipeline.port.kept', { port }));
      return;
    }

    if (driver.closeFirewall) {
      await driver.closeFirewall(ctx, port, (line) => stream.line('allocate_port', line));
    }
    await ctx.portAllocator.release(key);
    stream.line('allocate_port', workerSay(ctx.language)('pipeline.port.released', { port }));
    log.info({ port }, 'port libéré après échec');
  } catch (error) {
    // Le ménage ne doit jamais masquer la cause réelle de l'échec.
    log.error({ err: error }, 'libération du port impossible');
  }
}
