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
  UnhealthyReleaseError,
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
 * Running the deployment pipeline.
 *
 * The worker knows no runtime: it chains steps and delegates to the driver. A
 * step the driver cannot fulfill returns `null`, and it is **the driver** that
 * decides — never an `if (runtime === ...)` here.
 */

export type PipelineOutcome = {
  status: 'success' | 'failed' | 'rolled_back';
  url: string | null;
  publishedPort: number | null;
  failedStep: DeploymentStepKey | null;
  error: string | null;
  /** Version an automatic rollback brought back to, if any. */
  rolledBackTo: string | null;
};

/** State shared between the steps. */
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
  // The language of everything this deployment will write: its log, its errors.
  const language = await instanceLanguage();
  const say = workerSay(language);

  const record = await getDeploymentForRun(deploymentId);
  if (!record) throw new Error(say('notFound.deployment', { id: deploymentId }));

  const { deployment } = record;
  const log = logger.child({ deploymentId, runtime: deployment.runtime });
  const stream = new DeployLogStream(deploymentId, publisher);

  // Retry: what already succeeded is not replayed, the rest starts from scratch.
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
   * Port range chosen: the target's, narrowed by the worker's.
   *
   * Both tell a different truth. `targets.port_range_*` describes what that
   * machine accepts to publish; `DRIVER_PORT_RANGE` describes what the worker's
   * environment can reach — a tunnel, a host that only republishes a handful of
   * ports. Keeping the intersection respects both; keeping the last one read would
   * betray one.
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
    // The secrets' values come from the application's store, not from the
    // deployment: they must be the same at each release.
    resolveSecrets: secretResolverFor(deployment.applicationId),
    // A repository's code will go into the release's `source/`: the render must know
    // it to resolve the build contexts there.
    ...(carriesSourceCode(deployment, spec) ? { sourceInRelease: true } : {}),
  };

  const driver = getDriver(deployment.runtime);

  // Domains first, because they decide how the port is published: the AppSpec's at
  // the first deployment on this target, then the target's list. A proxy of the
  // machine reaches it through loopback; another's, through a port published on
  // the private address it reaches, opened to it alone. In both cases, the port is
  // no longer open to the world.
  if (!ctx.previousDeployment) {
    await seedRouteFromSpec(
      deployment.applicationId,
      deployment.targetId,
      spec,
      ctx.language,
      (line) => stream.line('preflight', line),
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
   * A step succeeds (`success`) or is not applicable (`skipped`) — failure goes
   * through an exception. `skipped` always comes from the driver or the provider,
   * never from a condition on the runtime written here.
   */
  type StepOutcome = 'success' | 'skipped';

  const handlers: Record<DeploymentStepKey, () => Promise<StepOutcome>> = {
    preflight: async () => {
      const report = await driver.preflight(ctx);
      for (const check of report.checks) {
        stream.line('preflight', `${check.ok ? '✓' : '✗'} ${check.label} — ${check.detail ?? ''}`);
      }
      if (!report.ok) throw new Error(say('pipeline.preflightRefused'));

      // Served by another machine's proxy: the connection from one to the other is
      // tested before building anything, on the range where the port will be
      // published. The arrival address noted becomes the one to open it to.
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

      // Opening the firewall. The worker does not ask which runtime it drives: it asks
      // whether the driver can open a port. A driver that does not expose by port does
      // not implement the method, and the step goes on without it.
      if (driver.openFirewall) {
        await driver.openFirewall(ctx, state.port, (line) => stream.line('allocate_port', line));
      } else {
        stream.line('allocate_port', say('pipeline.firewall.none'));
      }

      return 'success';
    },

    render: async () => {
      state.artifacts = await driver.render(ctx);
      // A retry skips `allocate_port` if it had already succeeded: the effective port
      // then comes from the render, which read it again.
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
      // A run coming from a linked repository brings its commit's code: the archive is
      // downloaded here, handed to the driver, then erased from the worker.
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
        // Two reasons to have nothing to do, and they are not equivalent: nobody asked
        // for a scan, or the instance turned it off for everybody. The second deserves
        // to be read in the deployment's log.
        stream.line(
          'scan',
          config.disabledBy === 'settings'
            ? say('pipeline.scan.disabled')
            : say('pipeline.scan.none'),
        );
        return 'skipped';
      }

      // The driver knows how it names its images; the worker does not.
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
     * The backup before deployment — or before an image update, which is a
     * redeploy. It backs up what is **still** running, just before it is replaced:
     * after the build and the analysis, so as to back up nothing of a deployment
     * that would not have happened.
     *
     * If it fails, the deployment stops there: it is the very meaning of the option.
     * Nothing has changed on the target yet.
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

      // The diagnosis was captured by the driver **before** returning: a rollback that
      // follows restarts the old version and would wipe the scene. We stream it line
      // by line, then attach it to the failure message so that it lands in
      // `deployment_steps.error`.
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
     * Nominal path: there is nothing to undo, the step is not applicable. The real
     * rollback is triggered further down, after `healthcheck`'s verdict — a step
     * cannot start itself in reaction to another's failure.
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
      // A domain that does not answer does not cancel a healthy deployment: the new
      // version runs. The route is marked as failed, the periodic probe warns, and the
      // step's log says why.
      for (const problem of applied.problems) stream.line('proxy', `⚠ ${problem}`, 'stderr');
      return 'success';
    },
  };

  let failedStep: DeploymentStepKey | null = null;
  let failure: string | null = null;
  /** The failed version took the previous one's place: we go back to it. */
  let unhealthyRelease = false;
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
      log.info({ step: key }, 'step started');

      try {
        const status = await handlers[key]();
        await finishStep(deploymentId, key, status);
        stream.event({ type: 'step', key, status, detail: null });
        log.info({ step: key, status }, 'step completed');
      } catch (error) {
        let message = error instanceof Error ? error.message : String(error);
        // A version put in place but left unhealthy reads as a failed healthcheck: the
        // same diagnosis, streamed before the rollback that would wipe the scene, and
        // attached to the step's error.
        if (error instanceof UnhealthyReleaseError && error.diagnostics) {
          for (const line of error.diagnostics.split('\n')) stream.line(key, line, 'stderr');
          message = `${message}\n\n${error.diagnostics}`;
        }
        await finishStep(deploymentId, key, 'failed', message);
        stream.line(key, message, 'stderr');
        stream.event({ type: 'step', key, status: 'failed', detail: message });
        log.error({ step: key, err: error }, 'step failed');

        failedStep = key;
        failure = message;
        unhealthyRelease = key === 'healthcheck' || error instanceof UnhealthyReleaseError;
        break;
      }
    }

    /**
     * Automatic rollback.
     *
     * Three conditions, all data: the new version took the previous one's place
     * without becoming healthy, the deployment's policy allows it, and there is an
     * earlier version to go back to. None is a global setting.
     *
     * "Without becoming healthy" is a failed `healthcheck` — or a `deploy` whose
     * driver says it replaced the services before waiting for their health
     * (`UnhealthyReleaseError`): Compose and Kubernetes both do. A failure elsewhere
     * — a blocking scan, a `deploy` that replaced nothing — triggers nothing: there
     * is nothing to undo, the previous version never stopped running.
     */
    if (unhealthyRelease && deployment.autoRollback && ctx.previousDeployment) {
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
         * The restored version must answer — and it is described with **its** spec, not
         * with the one that just failed.
         *
         * It is the whole point of freezing the AppSpec in each deployment: v2 may have
         * moved its health route, changed port or image. Probing it with v2's settings
         * would ask the wrong question to the right machine, and a successful rollback
         * would pass for a failure.
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
        // The URL becomes again that of the version really running.
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

        log.warn({ from: spec.version, to: restored.version }, 'automatic rollback done');
      } catch (error) {
        // **Never a second rollback.** A rollback that fails signals a problem that
        // replaying the same command will not fix, and chaining attempts would only move
        // the machine further from a known state.
        const message = error instanceof Error ? error.message : String(error);
        await finishStep(deploymentId, 'rollback', 'failed', message);
        stream.line('rollback', message, 'stderr');
        stream.event({ type: 'step', key: 'rollback', status: 'failed', detail: message });

        failure = say('pipeline.rollback.failed', {
          failure: failure ?? say('pipeline.healthcheckFailed'),
          error: message,
        });
        log.error({ err: error }, 'automatic rollback failed');

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
    // A port reserved for a deployment that started nothing is a lost port: nobody
    // will ever release it, and a target's range is not extensible. The `finally`
    // also covers the crash — an exception outside the pipeline must not leave a
    // trace behind it.
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
 * Releases the port reservation if nothing occupies it anymore.
 *
 * The condition is not "the deployment failed" but "no version of this
 * application runs on this target". The verdict comes from
 * `hasLiveDeploymentOnTarget()`, that is from the single definition of "alive"
 * carried by `@pupitre/db` — the worker does not have one of its own.
 *
 * The deployment that just failed goes into the computation instead of being
 * excluded from it: if it went past the `deploy` step, it is its own containers
 * occupying the port. An earlier failure — preflight, render, build, scan —
 * started nothing, and the reservation goes.
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
    log.info({ port }, 'port released after failure');
  } catch (error) {
    // Cleanup must never hide the real cause of the failure.
    log.error({ err: error }, 'port release failed');
  }
}
