import { PORT_RANGE_MAX, PORT_RANGE_MIN } from '../../ports.js';
import type { AppStatus, ServiceState, ServiceStatus } from '../../supervision.js';
import type { ProxyUpstream } from '../../proxy/model.js';
import type { ImageStore } from '../../scan.js';
import { exec, execPipe, execStream, upload } from '../../ssh/client.js';
import { exposedService, storedSecretNames, type AppSpec } from '../../spec/index.js';
import { backoffMs } from '../backoff.js';
import { listeningPorts } from '../listening.js';
import { releaseCandidates, releaseName } from '../release.js';
import { pruneReleases } from '../retention.js';
import { buildContextPath, extractSourceArchive } from '../source-archive.js';
import { ufwAllow, ufwAllowPort, ufwComment, ufwDelete } from '../ufw.js';
import {
  DriverError,
  type DeployResult,
  type DeploymentDriver,
  type DriverContext,
  type HealthOutcome,
  type HealthResult,
  type LogSink,
  type PreflightResult,
  type RenderedArtifacts,
  type RenderedFile,
  type TargetContext,
  UnhealthyReleaseError,
} from '../types.js';
import type { Readable, Writable } from 'node:stream';
import { digestOf } from '../../images/reference.js';
import type { RunningImage } from '../../images/updates.js';
import {
  managedWorkloadControlRefusal,
  managedWorkloadRefusal,
  type Workload,
  type WorkloadControlAction,
  type WorkloadRef,
} from '../../workloads.js';
import {
  quoteForShell,
  runBoundedExec,
  type WorkloadExecOptions,
  type WorkloadExecResult,
} from '../workload-exec.js';
import {
  COMPOSE_FILE,
  PROJECT_PREFIX,
  buildImageTag,
  projectName,
  renderFiles,
  volumeName,
} from './render.js';
import { firstLine, shellQuote } from '../../shell.js';
import { driverSay } from '../messages.js';
import { dockerSay } from './messages.js';

/**
 * Docker Compose driver.
 *
 * It imports nothing from `packages/db`, nothing from `apps/web`, nothing from
 * Redis. Everything arrives through `DriverContext` — port reservation
 * included, which goes through the `PortAllocator` interface implemented
 * elsewhere.
 *
 * Isolation: one Compose project per application, prefixed `app-{slug}`, with
 * its own bridge network and its own named volumes.
 */

const BUILD_TIMEOUT_MS = 20 * 60_000;
/** Allocation attempts before admitting the range cannot be used. */
const ATTEMPTS_PORT = 20;
const UP_TIMEOUT_MS = 10 * 60_000;
const SHORT_TIMEOUT_MS = 30_000;
/** Log lines brought back per service when the healthcheck fails. */
const DIAGNOSTIC_LINES = 200;
const DIAGNOSTIC_TIMEOUT_MS = 60_000;
/** Pulling an image can take several minutes on a slow link. */
const PULL_TIMEOUT_MS = 10 * 60_000;
const REMOVE_TIMEOUT_MS = 2 * 60_000;
/**
 * Time given to a container to shut down cleanly before SIGKILL. Compose's
 * default is 10 s, too short for a database flushing its buffers: a deliberate
 * stop must not corrupt what the contract promises to keep.
 */
const STOP_GRACE_SECONDS = 30;
/** Separates two outputs in a single shell invocation. */
const SENTINEL = '---tp-workloads---';

export class DockerComposeDriver implements DeploymentDriver {
  readonly runtime = 'docker' as const;

  /** The Compose project under which the application is grouped on the target. */
  workspaceName(appSlug: string): string {
    return projectName(appSlug);
  }

  /** The exact copy of `destroy()`, to run by hand on the machine. */
  manualCleanup(appSlug: string, rootPath: string): string[] {
    const appPath = `${rootPath}/apps/${appSlug}`;
    return [
      `cd ${appPath}/current && docker compose -p ${projectName(appSlug)} -f ${COMPOSE_FILE} down -v --remove-orphans`,
      `rm -rf ${appPath}`,
    ];
  }

  /** What the driver says, in the instance's language. */
  private say(ctx: TargetContext) {
    return dockerSay(ctx.language);
  }

  /** `/opt/bootstrap/apps/{slug}` */
  private appPath(ctx: DriverContext): string {
    return `${ctx.target.rootPath}/apps/${ctx.appSlug}`;
  }

  /** `/opt/bootstrap/apps/{slug}/{version}-r{number}` — see `releaseName()`. */
  private releasePath(ctx: DriverContext): string {
    return `${this.appPath(ctx)}/${releaseName(ctx.deployment)}`;
  }

  /** The tag of the images this release builds: the release itself. */
  private imageTag(ctx: DriverContext, service: string): string {
    return buildImageTag(ctx.appSlug, service, releaseName(ctx.deployment));
  }

  private project(ctx: DriverContext): string {
    return projectName(ctx.appSlug);
  }

  /**
   * `docker compose` run in a release's directory — always on **its** file and
   * **its** project, named: without `-f`, Compose would merge a
   * `compose.override.yml` found there; without `-p`, a `.env` could give it
   * another project name, and a `down -v` would aim at another application. The
   * release is only made of what Pupitre places in it, but a release from before
   * `source/` still carried a repository's code at its root.
   */
  private compose(ctx: DriverContext, args: string, releaseDir?: string): string {
    // An application deployed before the `-r{number}` naming still lives under the
    // version alone: its logs, its health, its restarts must keep working until its
    // next deployment.
    const into = releaseDir
      ? `cd ${shellQuote(releaseDir)}`
      : `{ cd ${shellQuote(this.releasePath(ctx))} 2>/dev/null || ` +
        `cd ${shellQuote(`${this.appPath(ctx)}/${ctx.deployment.version}`)}; }`;
    return (
      `${into} && ` +
      `docker compose -p ${shellQuote(this.project(ctx))} -f ${COMPOSE_FILE} ${args}`
    );
  }

  // ─── preflight ──────────────────────────────────────────────────────────────

  async preflight(ctx: DriverContext): Promise<PreflightResult> {
    const say = this.say(ctx);
    const checks: PreflightResult['checks'] = [];

    const info = await exec(ctx.sshSession, "docker info --format '{{.ServerVersion}}'", {
      timeout: SHORT_TIMEOUT_MS,
    });
    const runtimeVersion = info.code === 0 ? firstLine(info.stdout) : null;
    checks.push({
      key: 'docker_info',
      label: say('preflight.daemon'),
      ok: runtimeVersion !== null,
      detail: runtimeVersion ?? firstLine(info.stderr) ?? `code ${info.code}`,
    });

    const compose = await exec(ctx.sshSession, 'docker compose version --short', {
      timeout: SHORT_TIMEOUT_MS,
    });
    const composeVersion = compose.code === 0 ? firstLine(compose.stdout) : null;
    checks.push({
      key: 'docker_compose',
      label: 'Docker Compose',
      ok: composeVersion !== null,
      detail: composeVersion ?? firstLine(compose.stderr) ?? `code ${compose.code}`,
    });

    // `df` on the closest existing parent: the driver's root may not exist yet on a
    // new target.
    const disk = await exec(
      ctx.sshSession,
      `df -Pk ${shellQuote(ctx.target.rootPath)} 2>/dev/null || df -Pk /`,
      { timeout: SHORT_TIMEOUT_MS },
    );
    const availableDiskMi = parseAvailableMi(disk.stdout);
    const enoughDisk = availableDiskMi !== null && availableDiskMi >= 1024;
    checks.push({
      key: 'disk',
      label: say('preflight.disk'),
      ok: enoughDisk,
      detail:
        availableDiskMi === null
          ? say('preflight.disk.unreadable')
          : say('preflight.disk.available', { gib: Math.round(availableDiskMi / 1024) }),
    });

    const workdir = await this.ensureWorkdir(ctx);
    checks.push({
      key: 'workdir',
      label: say('preflight.workdir'),
      ok: workdir.ok,
      detail: workdir.detail,
    });

    return {
      ok: checks.every((check) => check.ok),
      runtimeVersion,
      availableDiskMi,
      checks,
    };
  }

  /**
   * Makes sure the driver's root is writable by the deployment account.
   *
   * `/opt` belongs to root on a standard machine: the first run needs elevation
   * to create the tree and give it to the account. The following ones no longer
   * need it, and an already provisioned target never does.
   */
  private async ensureWorkdir(
    ctx: DriverContext,
  ): Promise<{ ok: boolean; detail: string | null }> {
    const appPath = this.appPath(ctx);
    const direct = await exec(
      ctx.sshSession,
      `mkdir -p ${shellQuote(appPath)} && test -w ${shellQuote(appPath)}`,
      { timeout: SHORT_TIMEOUT_MS },
    );
    if (direct.code === 0) return { ok: true, detail: appPath };

    // The identity must be resolved BEFORE elevation: under `sudo`, `id -u` would
    // answer 0 and the chown would give the tree to root.
    const identity = await exec(ctx.sshSession, 'id -u; id -g', {
      timeout: SHORT_TIMEOUT_MS,
    });
    const [uid, gid] = identity.stdout.trim().split('\n').map((value) => value.trim());
    if (identity.code !== 0 || !uid || !gid) {
      return { ok: false, detail: this.say(ctx)('workdir.identity') };
    }

    const elevated = await exec(
      ctx.sshSession,
      `mkdir -p ${shellQuote(appPath)} && chown -R ${uid}:${gid} ${shellQuote(ctx.target.rootPath)}`,
      { sudo: true, timeout: SHORT_TIMEOUT_MS },
    );
    if (elevated.code !== 0) {
      return {
        ok: false,
        detail:
          firstLine(elevated.stderr) ??
          firstLine(direct.stderr) ??
          this.say(ctx)('workdir.sudoFailed', { root: ctx.target.rootPath }),
      };
    }

    // We check again rather than trust the exit code: writing is what counts, not
    // the chown's apparent success.
    const confirmed = await exec(ctx.sshSession, `test -w ${shellQuote(appPath)}`, {
      timeout: SHORT_TIMEOUT_MS,
    });
    return confirmed.code === 0
      ? { ok: true, detail: this.say(ctx)('workdir.provisioned', { path: appPath }) }
      : { ok: false, detail: this.say(ctx)('workdir.stillReadOnly', { path: appPath }) };
  }

  // ─── allocatePort ───────────────────────────────────────────────────────────

  /**
   * Uniqueness between the panel's applications is held by the
   * `(target_id, port)` constraint in the database. The driver tests nothing about
   * it: it asks, the database decides.
   *
   * What remains is what the database cannot know — a service installed by hand
   * on the target, already listening on the drawn port. We notice it afterwards,
   * declare the allocation dead, and start again excluding that port. A
   * reservation already held by this application is never questioned: the port
   * is taken, yes, but by us.
   */
  async allocatePort(ctx: DriverContext, onLog?: LogSink): Promise<number | null> {
    const say = this.say(ctx);
    if (!ctx.portAllocator) {
      throw new DriverError(say('port.allocatorMissing'), this.runtime, 'allocate_port');
    }

    const allocator = ctx.portAllocator;
    const key = { targetId: ctx.target.id, applicationId: ctx.applicationId };
    const log = onLog ?? (() => {});

    const existing = await allocator.current(key);
    if (existing !== null) return existing;

    const range = {
      min: ctx.portRange?.min ?? PORT_RANGE_MIN,
      max: ctx.portRange?.max ?? PORT_RANGE_MAX,
    };

    // A single probe for the whole loop: the target's port state does not change
    // during the few milliseconds of a retry.
    const inUse = await listeningPorts(ctx);
    if (inUse === null) {
      log(say('port.noProbe'));
    }

    const dead: number[] = [];

    for (let attempt = 0; attempt < ATTEMPTS_PORT; attempt += 1) {
      const port = await allocator.allocate({ ...key, ...range, exclude: dead });

      if (inUse === null || !inUse.has(port)) {
        if (dead.length > 0) {
          log(say('port.reservedAfter', { port, count: dead.length }));
        }
        return port;
      }

      // Dead reservation: the database granted it, the target says otherwise. We
      // release it so as not to tie up a port we will do nothing with, and set it
      // aside from the next draw.
      log(say('port.busy', { port, target: ctx.target.name }));
      await allocator.release(key);
      dead.push(port);
    }

    throw new DriverError(
      say('port.exhausted', {
        min: range.min,
        max: range.max,
        target: ctx.target.name,
        count: dead.length,
        ports: dead.join(', '),
      }),
      this.runtime,
      'allocate_port',
    );
  }

  // ─── firewall ───────────────────────────────────────────────────────────────

  /**
   * Opens the port on UFW.
   *
   * `DockerComposeDriver` publishes on an interface of the machine: the firewall
   * concerns it. `K3sDriver` does not implement these methods at all — exposure
   * goes through the Ingress there. The pipeline calls them if the method exists,
   * without ever looking at which runtime it is.
   */
  /** The port published on the machine: a local proxy reaches it through the loopback. */
  upstream(_ctx: DriverContext, publishedPort: number | null): ProxyUpstream | null {
    return publishedPort === null ? null : { kind: 'port', port: publishedPort };
  }

  async openFirewall(ctx: DriverContext, port: number, onLog?: LogSink): Promise<void> {
    const exposure = ctx.exposure;
    if (exposure?.bindAddress && (isLoopback(exposure.bindAddress) || !exposure.byPort)) {
      // Published for the machine's proxy only — on the loopback, or on the Docker
      // gateway a container proxy reaches: nobody else gets there, nothing to open.
      onLog?.(this.say(ctx)('firewall.localOnly', { port, address: exposure.bindAddress }));
      return;
    }
    if (exposure?.allowFrom) {
      // A remote proxy: the port only opens to it.
      await ufwAllowPort(
        ctx,
        port,
        ufwComment(ctx.appSlug),
        onLog ?? (() => {}),
        exposure.allowFrom,
      );
      return;
    }
    await ufwAllow(ctx, port, onLog ?? (() => {}));
  }

  async closeFirewall(ctx: DriverContext, port: number, onLog?: LogSink): Promise<void> {
    await ufwDelete(ctx, port, onLog ?? (() => {}));
  }

  // ─── render ─────────────────────────────────────────────────────────────────

  async render(ctx: DriverContext): Promise<RenderedArtifacts> {
    const publishedPort = await this.resolvePublishedPort(ctx);
    // Roots only: an alias has no value of its own to ask for.
    const secretNames = storedSecretNames(ctx.spec);
    const secretValues = ctx.resolveSecrets ? await ctx.resolveSecrets(secretNames) : {};

    const files = renderFiles({
      spec: ctx.spec,
      appSlug: ctx.appSlug,
      publishedPort,
      ...(ctx.exposure?.bindAddress ? { publishAddress: ctx.exposure.bindAddress } : {}),
      ...(ctx.sourceInRelease ? { sourceInRelease: true } : {}),
      imageTag: releaseName(ctx.deployment),
      secretValues,
      language: ctx.language,
    });

    return { projectName: this.project(ctx), files, publishedPort };
  }

  /**
   * Compose cannot spread a published port across several replicas. Beyond one
   * replica, exposure must go through the proxy: the driver then publishes no
   * port and says so.
   */
  private async resolvePublishedPort(ctx: DriverContext): Promise<number | null> {
    const exposed = exposedService(ctx.spec);
    if (exposed.replicas > 1) return null;

    if (ctx.portAllocator) {
      const existing = await ctx.portAllocator.current({
        targetId: ctx.target.id,
        applicationId: ctx.applicationId,
      });
      return existing ?? (await this.allocatePort(ctx));
    }
    return null;
  }

  // ─── upload ─────────────────────────────────────────────────────────────────

  async upload(
    ctx: DriverContext,
    artifacts: RenderedArtifacts,
    onLog: LogSink,
  ): Promise<void> {
    const say = this.say(ctx);
    const release = this.releasePath(ctx);
    onLog(say('upload.release', { project: artifacts.projectName, release }));

    const workdir = await this.ensureWorkdir(ctx);
    if (!workdir.ok) {
      throw new DriverError(
        say('upload.workdirUnusable', { detail: workdir.detail ?? say('upload.unknownReason') }),
        this.runtime,
        'upload',
      );
    }
    await this.run(ctx, `mkdir -p ${shellQuote(release)}`, onLog, 'upload');

    // The code of a linked repository goes into `source/`, apart. The `.env` of a
    // previous deployment of the same version must not survive a render that no
    // longer has one: it is rewritten if needed.
    if (ctx.sourceArchive) {
      await extractSourceArchive(
        ctx.sshSession,
        release,
        ctx.sourceArchive,
        onLog,
        this.runtime,
        ctx.language,
      );
    }
    await this.run(ctx, `rm -f ${shellQuote(`${release}/.env`)}`, onLog, 'upload');

    const files: RenderedFile[] = [...(ctx.additionalFiles ?? []), ...artifacts.files];
    for (const file of files) {
      await this.uploadFile(ctx, release, file, onLog);
    }

    await this.assertBuildContexts(ctx, release, onLog);
  }

  // ─── build ──────────────────────────────────────────────────────────────────

  /** `null` when no service is built: the step is then `skipped`. */
  async build(ctx: DriverContext, onLog: LogSink): Promise<string[] | null> {
    const buildable = ctx.spec.services.filter(
      (service) => service.source.type === 'dockerfile',
    );
    if (buildable.length === 0) return null;

    onLog(`docker compose build (${buildable.map((s) => s.name).join(', ')})`);
    await this.stream(ctx, this.compose(ctx, 'build --pull'), onLog, 'build', BUILD_TIMEOUT_MS);

    return buildable.map((service) => this.imageTag(ctx, service.name));
  }

  // ─── images ─────────────────────────────────────────────────────────────────

  /**
   * Derived from the AppSpec, not from the target: the list must be known before
   * anything runs, so the scanners can analyze it.
   */
  async images(ctx: DriverContext): Promise<string[]> {
    return ctx.spec.services.map((service) =>
      service.source.type === 'image' ? service.source.ref : this.imageTag(ctx, service.name),
    );
  }

  /** The Docker daemon, which the SSH user reaches through the `docker` group. */
  imageStore(_ctx: DriverContext): ImageStore {
    return { kind: 'docker' };
  }

  // ─── deploy ─────────────────────────────────────────────────────────────────

  async deploy(ctx: DriverContext, onLog: LogSink): Promise<DeployResult> {
    const release = this.releasePath(ctx);
    const publishedPort = await this.resolvePublishedPort(ctx);

    onLog('docker compose pull');
    // A failed pull is not fatal: the image may already be on the target, and an
    // image built locally exists in no registry.
    await this.stream(
      ctx,
      this.compose(ctx, 'pull --ignore-pull-failures'),
      onLog,
      'pull',
      BUILD_TIMEOUT_MS,
      false,
    );

    onLog('docker compose up -d --remove-orphans');
    try {
      await this.stream(
        ctx,
        this.compose(ctx, 'up -d --remove-orphans --wait --wait-timeout 300'),
        onLog,
        'up',
        UP_TIMEOUT_MS,
      );
    } catch (error) {
      throw await this.upFailure(ctx, error);
    }

    // Marks the current release: `rollback()` and `destroy()` use it.
    await this.run(
      ctx,
      `ln -sfn ${shellQuote(release)} ${shellQuote(`${this.appPath(ctx)}/current`)}`,
      onLog,
      'link',
    );

    // Cleanup of old versions, once `current` is up to date: it is the only moment
    // we know which one must above all not go. Their built images go with them: one
    // tag per release, without cleanup, the target's disk would fill up.
    const pruned = await pruneReleases(ctx, this.appPath(ctx), onLog);
    await this.removeBuiltImages(ctx, pruned, onLog);

    const images = await this.listImages(ctx);
    const url = this.buildUrl(ctx, publishedPort);

    onLog(url ? this.say(ctx)('deploy.startedAt', { url }) : this.say(ctx)('deploy.started'));

    return { ok: true, url, publishedPort, releasePath: release, images };
  }

  /**
   * What a failed `up --wait` really says.
   *
   * Compose replaces the containers **then** waits for their health: when the
   * wait fails, the old version is already no longer running. A container that
   * carries this release's directory — the `working_dir` label Compose sets on
   * each one — is the proof: the failure is then that of an unhealthy version,
   * and the pipeline goes back to the previous one. Without such a container,
   * `up` stopped before replacing anything: the error stays its own.
   */
  private async upFailure(ctx: DriverContext, error: unknown): Promise<unknown> {
    if (!(error instanceof DriverError)) return error;

    const filters = [
      `label=com.docker.compose.project=${this.project(ctx)}`,
      `label=com.docker.compose.project.working_dir=${this.releasePath(ctx)}`,
    ];
    const placed = await exec(
      ctx.sshSession,
      `docker ps -aq ${filters.map((filter) => `--filter ${shellQuote(filter)}`).join(' ')}`,
      { timeout: SHORT_TIMEOUT_MS },
    );
    if (placed.code !== 0 || placed.stdout.trim().length === 0) return error;

    const ps = await exec(ctx.sshSession, this.compose(ctx, 'ps -a --format json'), {
      timeout: SHORT_TIMEOUT_MS,
    });
    const failing = parseComposePs(ps.stdout)
      .filter(
        (service) =>
          service.state !== 'running' ||
          service.health === 'unhealthy' ||
          service.health === 'starting',
      )
      .map(
        (service) =>
          `${service.name} (${service.state === 'running' ? service.health : service.state})`,
      );

    return new UnhealthyReleaseError(
      this.say(ctx)('deploy.unhealthy', {
        services: failing.length > 0 ? failing.join(', ') : error.message,
      }),
      this.runtime,
      'up',
      await this.diagnose(ctx),
      error,
    );
  }

  /** URL through which the application must answer. */
  private buildUrl(ctx: DriverContext, publishedPort: number | null): string | null {
    const ingress = ctx.spec.ingress;
    if (ingress?.host) {
      return `${ingress.tls ? 'https' : 'http'}://${ingress.host}`;
    }
    if (publishedPort === null) return null;
    return `http://${ctx.target.host}:${publishedPort}`;
  }

  /**
   * A service to build requires its build context to have been placed. The
   * driver does not go and fetch it: it checks and fails clearly.
   */
  private async assertBuildContexts(
    ctx: DriverContext,
    release: string,
    onLog: LogSink,
  ): Promise<void> {
    for (const service of ctx.spec.services) {
      if (service.source.type !== 'dockerfile') continue;

      const context = buildContextPath(service.source.context, ctx.sourceInRelease);
      const dockerfile = `${release}/${context}/${service.source.dockerfile}`;
      const check = await exec(ctx.sshSession, `test -f ${shellQuote(dockerfile)}`, {
        timeout: SHORT_TIMEOUT_MS,
      });
      if (check.code !== 0) {
        const say = this.say(ctx);
        onLog(say('build.contextMissing.log', { service: service.name, dockerfile }));
        throw new DriverError(
          say('build.contextMissing', {
            service: service.name,
            dockerfile: service.source.dockerfile,
            dir: `${release}/${context}`,
            hint: ctx.sourceInRelease
              ? say('build.contextMissing.fromRepo')
              : say('build.contextMissing.additionalFiles'),
          }),
          this.runtime,
          'build_context',
        );
      }
    }
  }

  private async uploadFile(
    ctx: DriverContext,
    release: string,
    file: RenderedFile,
    onLog: LogSink,
  ): Promise<void> {
    const remote = `${release}/${file.path}`;
    const directory = remote.slice(0, remote.lastIndexOf('/'));

    await this.run(ctx, `mkdir -p ${shellQuote(directory)}`, onLog, 'prepare');
    await upload(ctx.sshSession, Buffer.from(file.content, 'utf8'), remote);

    if (file.mode !== undefined) {
      await this.run(
        ctx,
        `chmod ${file.mode.toString(8).padStart(4, '0')} ${shellQuote(remote)}`,
        onLog,
        'prepare',
      );
    }
    // The content is never logged: `.env` carries the secrets.
    onLog(this.say(ctx)('upload.deposited', { path: file.path, bytes: file.content.length }));
  }

  private async listImages(ctx: DriverContext): Promise<string[]> {
    const result = await exec(
      ctx.sshSession,
      this.compose(ctx, "config --images 2>/dev/null || true"),
      { timeout: SHORT_TIMEOUT_MS },
    );
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  // ─── healthcheck ────────────────────────────────────────────────────────────

  async healthcheck(ctx: DriverContext): Promise<HealthResult> {
    const say = this.say(ctx);
    const service = exposedService(ctx.spec);
    const { retries, intervalSec, timeoutSec, path } = service.healthcheck;

    const ps = await exec(ctx.sshSession, this.compose(ctx, 'ps --format json'), {
      timeout: SHORT_TIMEOUT_MS,
    });
    const running = countRunning(ps.stdout);
    if (running === 0) {
      return this.unhealthy(ctx, {
        outcome: 'unreachable',
        attempts: 0,
        statusCode: null,
        detail: say('health.noContainer'),
      });
    }

    const publishedPort = await this.resolvePublishedPort(ctx);
    if (publishedPort === null) {
      // Without a published port, the HTTP probe from the host has no target: we rely
      // on the containers' state, held by their own healthcheck.
      const unhealthy = await exec(
        ctx.sshSession,
        this.compose(ctx, "ps --format '{{.Health}}' | grep -c unhealthy || true"),
        { timeout: SHORT_TIMEOUT_MS },
      );
      const bad = Number.parseInt(firstLine(unhealthy.stdout) ?? '0', 10);
      const detail = say('health.noPort', { running, bad });

      return bad === 0
        ? { healthy: true, outcome: 'healthy', attempts: 1, statusCode: null, detail, diagnostics: null }
        : this.unhealthy(ctx, {
            outcome: 'unhealthy',
            attempts: 1,
            statusCode: null,
            detail,
          });
    }

    // The port may have been published on a single address — the one a remote
    // proxy reaches —: it then only listens there, and that is where it is probed.
    // Compose says so itself, which also holds for the periodic probe, which knows
    // nothing of how the application was published.
    const bound = await exec(
      ctx.sshSession,
      this.compose(ctx, `port ${shellQuote(service.name)} ${service.port} 2>/dev/null | head -n 1`),
      { timeout: SHORT_TIMEOUT_MS },
    );
    const url = `http://${probeHostOf(firstLine(bound.stdout))}:${publishedPort}${path}`;
    let lastStatus: number | null = null;
    let lastDetail: string | null = null;
    let lastOutcome: HealthOutcome = 'unreachable';

    for (let attempt = 1; attempt <= retries; attempt += 1) {
      const probe = await exec(
        ctx.sshSession,
        `curl -s -o /dev/null -w '%{http_code}' -m ${timeoutSec} ${shellQuote(url)}`,
        { timeout: (timeoutSec + 5) * 1000 },
      );

      const status = Number.parseInt(firstLine(probe.stdout) ?? '', 10);
      // `curl` writes "000" when it got nothing: it is not an HTTP code, it is the
      // absence of an answer.
      lastStatus = Number.isNaN(status) || status === 0 ? null : status;
      lastOutcome = lastStatus === null ? 'unreachable' : 'unhealthy';
      lastDetail =
        lastStatus !== null
          ? say('health.http', { status: lastStatus, url })
          : say('health.unreachable', {
              url,
              code: probe.code,
              detail: firstLine(probe.stderr) ? ` : ${firstLine(probe.stderr)}` : '',
            });

      if (lastStatus !== null && lastStatus >= 200 && lastStatus < 400) {
        return {
          healthy: true,
          outcome: 'healthy',
          attempts: attempt,
          statusCode: lastStatus,
          detail: url,
          diagnostics: null,
        };
      }

      if (attempt < retries) await sleep(backoffMs(intervalSec, attempt));
    }

    return this.unhealthy(ctx, {
      outcome: lastOutcome,
      attempts: retries,
      statusCode: lastStatus,
      detail: lastDetail,
    });
  }

  /**
   * Builds the failure result **after capturing the scene**.
   *
   * The order matters: an automatic rollback restarts the previous version and
   * wipes the state that explained the failure. The diagnosis must therefore be
   * taken before the probe returns, not when someone reads it.
   */
  private async unhealthy(
    ctx: DriverContext,
    partial: Omit<HealthResult, 'healthy' | 'diagnostics'>,
  ): Promise<HealthResult> {
    return {
      healthy: false,
      diagnostics: await this.diagnose(ctx),
      ...partial,
    };
  }

  /** `docker compose ps` + the last 200 log lines of each service. */
  private async diagnose(ctx: DriverContext): Promise<string | null> {
    const sections: string[] = [];

    const ps = await exec(ctx.sshSession, this.compose(ctx, 'ps -a'), {
      timeout: SHORT_TIMEOUT_MS,
    });
    if (ps.stdout.trim().length > 0) {
      sections.push(`$ docker compose ps -a\n${ps.stdout.trim()}`);
    }

    for (const service of ctx.spec.services) {
      const logs = await exec(
        ctx.sshSession,
        this.compose(ctx, `logs --no-color --tail ${DIAGNOSTIC_LINES} ${shellQuote(service.name)}`),
        { timeout: DIAGNOSTIC_TIMEOUT_MS },
      );
      const output = `${logs.stdout}\n${logs.stderr}`.trim();
      sections.push(
        `$ docker compose logs --tail ${DIAGNOSTIC_LINES} ${service.name}\n` +
          (output.length > 0 ? output : this.say(ctx)('diagnose.noOutput')),
      );
    }

    return sections.length > 0 ? sections.join('\n\n') : null;
  }

  /**
   * The built images of the releases just deleted. Those of services pulled from
   * a registry are not ours: we do not touch them. An image still in use (a
   * container uses it) is refused by Docker: that is the intended behavior, not
   * an error.
   */
  private async removeBuiltImages(
    ctx: DriverContext,
    releases: readonly string[],
    onLog: LogSink,
  ): Promise<void> {
    const built = ctx.spec.services.filter((service) => service.source.type === 'dockerfile');
    if (releases.length === 0 || built.length === 0) return;
    const tags = releases.flatMap((release) =>
      built.map((service) => buildImageTag(ctx.appSlug, service.name, release)),
    );
    await exec(
      ctx.sshSession,
      `docker image rm ${tags.map(shellQuote).join(' ')} >/dev/null 2>&1; true`,
      { timeout: SHORT_TIMEOUT_MS },
    );
    onLog(this.say(ctx)('images.removed', { count: tags.length }));
  }

  // ─── rollback ───────────────────────────────────────────────────────────────

  async rollback(ctx: DriverContext, onLog: LogSink): Promise<void> {
    const say = this.say(ctx);
    const previous = ctx.previousDeployment;
    if (!previous) {
      throw new DriverError(say('rollback.previousMissing'), this.runtime, 'rollback');
    }

    // The previous release, by its name; otherwise, under the name from before
    // `-r{number}` — a release placed before the update.
    let target: string | null = null;
    for (const name of releaseCandidates(previous)) {
      const candidate = `${this.appPath(ctx)}/${name}`;
      const exists = await exec(
        ctx.sshSession,
        `test -f ${shellQuote(`${candidate}/${COMPOSE_FILE}`)}`,
        { timeout: SHORT_TIMEOUT_MS },
      );
      if (exists.code === 0) {
        target = candidate;
        break;
      }
    }
    if (!target) {
      throw new DriverError(
        say('rollback.releaseGone', { release: releaseName(previous), path: this.appPath(ctx) }),
        this.runtime,
        'rollback',
      );
    }

    onLog(say('rollback.to', { release: releaseName(previous) }));
    await this.stream(
      ctx,
      this.compose(ctx, 'up -d --remove-orphans --wait --wait-timeout 300', target),
      onLog,
      'rollback',
      UP_TIMEOUT_MS,
    );

    await this.run(
      ctx,
      `ln -sfn ${shellQuote(target)} ${shellQuote(`${this.appPath(ctx)}/current`)}`,
      onLog,
      'link',
    );
    onLog(say('rollback.done', { release: releaseName(previous) }));
  }

  // ─── destroy ────────────────────────────────────────────────────────────────

  /** Version retention: see `DeploymentDriver.pruneReleases`. */
  async pruneReleases(ctx: DriverContext, onLog: LogSink, keep?: number): Promise<string[]> {
    return pruneReleases(ctx, this.appPath(ctx), onLog, keep);
  }

  async destroy(ctx: DriverContext, onLog: LogSink): Promise<void> {
    const say = this.say(ctx);
    const appPath = this.appPath(ctx);
    const key = { targetId: ctx.target.id, applicationId: ctx.applicationId };

    // Read before any destruction: after `release()`, nobody knows which port to
    // close anymore.
    const port = ctx.portAllocator ? await ctx.portAllocator.current(key) : null;

    onLog('→ docker compose down -v');
    // `|| true`: destroying an app already gone must stay idempotent.
    await this.stream(
      ctx,
      `cd ${shellQuote(appPath)}/current 2>/dev/null && ` +
        `docker compose -p ${shellQuote(this.project(ctx))} -f ${COMPOSE_FILE} down -v --remove-orphans || true`,
      onLog,
      'destroy',
      UP_TIMEOUT_MS,
      false,
    );

    // The images built for the application, all releases together: `down` does not
    // remove them, and they would pile up on the disk. The same image can carry
    // several release tags — hence `-f`, safely: the pattern only designates this
    // application's images.
    const images = `${this.project(ctx)}/*`;
    onLog(say('destroy.images', { images }));
    await this.run(
      ctx,
      `ids=$(docker image ls -q --filter reference=${shellQuote(images)} | sort -u); ` +
        '[ -z "$ids" ] || docker image rm -f $ids >/dev/null 2>&1; true',
      onLog,
      'destroy',
    );

    onLog(say('destroy.removing', { path: appPath }));
    await this.run(ctx, `rm -rf ${shellQuote(appPath)}`, onLog, 'destroy');

    if (port !== null) {
      onLog(say('destroy.closingPort', { port }));
      await this.closeFirewall(ctx, port, onLog);
    }

    if (ctx.portAllocator) {
      await ctx.portAllocator.release(key);
      onLog(say('destroy.portReleased'));
    }

    onLog(say('destroy.done'));
  }

  // ─── logs ───────────────────────────────────────────────────────────────────

  async logs(ctx: DriverContext, onLine: LogSink): Promise<void> {
    await execStream(
      ctx.sshSession,
      this.compose(ctx, 'logs -f --no-color --tail 200'),
      (line) => onLine(line),
      // A log follow has no natural end: it is the caller that cuts the session when
      // it is done.
      { timeout: null, logOutput: false },
    );
  }

  // ─── supervision ────────────────────────────────────────────────────────────

  /**
   * `docker compose ps --format json` outputs either an array or one object per
   * line depending on the Compose version. We accept both.
   */
  async status(ctx: DriverContext): Promise<AppStatus> {
    const result = await exec(ctx.sshSession, this.compose(ctx, 'ps -a --format json'), {
      timeout: SHORT_TIMEOUT_MS,
      logOutput: false,
    });

    const checkedAt = new Date().toISOString();
    if (result.code !== 0) return { services: [], checkedAt };

    return { services: parseComposePs(result.stdout), checkedAt };
  }

  async restart(ctx: DriverContext, onLog: LogSink): Promise<void> {
    onLog('docker compose restart');
    await this.stream(ctx, this.compose(ctx, 'restart'), onLog, 'restart', UP_TIMEOUT_MS);
    onLog(this.say(ctx)('restart.done'));
  }

  /**
   * `docker compose stop`: the containers stay created, in the `exited` state.
   *
   * Neither `down` (which deletes the containers and the network) nor `pause`
   * (which leaves the processes in memory and keeps the port bound, hence
   * reserved for nothing): `stop` is the only one of the three that gives back the
   * execution resources while keeping volumes, network and configuration intact.
   *
   * The host port is freed with the container — measured: `docker compose ps`
   * shows no binding anymore after the stop. The reservation in the database
   * stays: it is what guarantees nobody takes that port while the application is
   * stopped, and that `start()` finds it again.
   *
   * Idempotent: on a project already stopped, Compose exits with 0 doing nothing.
   */
  async stop(ctx: DriverContext, onLog: LogSink): Promise<void> {
    onLog(`docker compose stop --timeout ${STOP_GRACE_SECONDS}`);
    await this.stream(
      ctx,
      this.compose(ctx, `stop --timeout ${STOP_GRACE_SECONDS}`),
      onLog,
      'stop',
      UP_TIMEOUT_MS,
    );
    onLog(this.say(ctx)('stop.done'));
  }

  /**
   * `docker compose start`, with a safety net.
   *
   * Measured on the test target: when no container of the project exists anymore
   * — a `docker system prune` went by, or someone cleaned up by hand —, `start`
   * fails with code 1 on "no container found for project". There is then nothing
   * to restart, but there is everything needed to recreate it: the in-service
   * version's `compose.yml` is still on the target.
   *
   * Hence the fallback to `up -d`, without `pull` and without `build`: we bring
   * up exactly the file already placed, with the named volumes, which had not
   * disappeared. It is the only way to keep the contract's promise — "put back in
   * service what `deploy()` had set up" — in a case where the literal command no
   * longer can.
   */
  async start(ctx: DriverContext, onLog: LogSink): Promise<void> {
    onLog('docker compose start');
    const started = await exec(ctx.sshSession, this.compose(ctx, 'start'), {
      timeout: UP_TIMEOUT_MS,
    });

    if (started.code !== 0) {
      onLog(`  ${firstLine(started.stderr) ?? `code ${started.code}`}`);
      onLog(this.say(ctx)('start.recreating'));
      await this.stream(
        ctx,
        this.compose(ctx, 'up -d --remove-orphans --wait --wait-timeout 300'),
        onLog,
        'start',
        UP_TIMEOUT_MS,
      );
      onLog(this.say(ctx)('start.recreated'));
      return;
    }

    // `start` returns as soon as the container is launched, not when it is healthy.
    // `up -d --wait` on an already started project recreates nothing and waits for
    // the probes: it is the cheapest way to honor "returns when the services are
    // ready".
    await this.stream(
      ctx,
      this.compose(ctx, 'up -d --remove-orphans --wait --wait-timeout 300'),
      onLog,
      'start',
      UP_TIMEOUT_MS,
    );
    onLog(this.say(ctx)('start.done'));
  }

  // ─── the target's workloads ─────────────────────────────────────────────────

  /**
   * Everything running on the machine, the panel included.
   *
   * Two commands in a single session: `docker ps` for the human wording of the
   * state ("Up 2 hours"), which only it produces, and `docker inspect` for the
   * rest. Labels are only read from `inspect`: `docker ps`'s `{{.Labels}}`
   * flattens them into a comma-separated list, but a label value can contain
   * commas — `maintainer=NGINX Docker Maintainers` is enough to break the split.
   */
  async listWorkloads(ctx: TargetContext): Promise<Workload[]> {
    const script = [
      "docker ps -a --no-trunc --format '{{.ID}} {{.Status}}'",
      `echo "${SENTINEL}"`,
      // `docker inspect` without an argument is an error: the "no container" case
      // must produce an empty array, not an exit code.
      'ids=$(docker ps -aq --no-trunc)',
      'if [ -n "$ids" ]; then docker inspect $ids; else echo "[]"; fi',
    ].join('\n');

    const result = await exec(ctx.sshSession, script, {
      timeout: SHORT_TIMEOUT_MS,
      // The output carries the containers' environment variables: it never goes into
      // a log.
      logOutput: false,
    });

    if (result.code !== 0) {
      throw new DriverError(
        this.say(ctx)('workload.inventoryFailed', {
          detail: firstLine(result.stderr) ?? `code ${result.code}`,
        }),
        this.runtime,
        'workload.list',
      );
    }

    const marker = result.stdout.indexOf(SENTINEL);
    const statuses = parsePsStatuses(marker < 0 ? '' : result.stdout.slice(0, marker));
    const inspected = parseInspect(marker < 0 ? result.stdout : result.stdout.slice(marker + SENTINEL.length));

    return inspected.map((raw) => toWorkload(raw, statuses));
  }

  /**
   * Deletes a container.
   *
   * `docker rm -f` and nothing more: no `-v`. The anonymous volumes of a container
   * foreign to the panel may carry data nobody here is able to assess — deleting
   * them would be a choice made in their owner's place.
   */
  async removeWorkload(ctx: TargetContext, ref: WorkloadRef, onLog: LogSink): Promise<void> {
    const { raw, workload } = await this.findWorkload(ctx, ref, 'workload.remove');

    // A second lock, after the route's: a driver does not trust its caller for an
    // irreversible operation.
    if (workload.managed) {
      throw new DriverError(
        managedWorkloadRefusal(workload, ctx.language),
        this.runtime,
        'workload.remove',
      );
    }

    onLog(
      this.say(ctx)('workload.removing', { name: workload.name, id: shortId(raw.Id ?? ref.id) }),
    );
    await this.stream(
      ctx,
      `docker rm -f ${shellQuote(ref.id)}`,
      onLog,
      'workload.remove',
      REMOVE_TIMEOUT_MS,
    );
    onLog(this.say(ctx)('workload.removed'));
  }

  /**
   * Updating, in Docker, means exactly this:
   *
   *   1. `docker pull` of the image the container runs, at its current tag;
   *   2. reading its effective configuration again (`docker inspect`);
   *   3. recreating a new container, same name, same configuration, on the
   *      freshly pulled image.
   *
   * "Same configuration" is read as a difference with the image the container was
   * running: only the values someone explicitly set at creation are carried
   * over. Copying the full environment would freeze the old image's defaults in
   * the new container, and therefore cancel part of the update just pulled.
   *
   * The old container is renamed and stopped rather than deleted: if the creation
   * fails, it is put back under its name and restarted. A failed update must not
   * leave the machine with one service fewer.
   */
  async updateWorkload(ctx: TargetContext, ref: WorkloadRef, onLog: LogSink): Promise<void> {
    const say = this.say(ctx);
    const { raw, workload } = await this.findWorkload(ctx, ref, 'workload.update');

    if (workload.managed) {
      throw new DriverError(
        say('workload.update.managed', { name: workload.name }),
        this.runtime,
        'workload.update',
      );
    }

    const image = raw.Config?.Image;
    if (!image) {
      throw new DriverError(
        say('workload.update.noImage', { name: workload.name }),
        this.runtime,
        'workload.update',
      );
    }

    // Defaults of the image **this container runs**, designated by its digest: the
    // tag will change underfoot at the next `pull`.
    const previousImageId = raw.Image ?? image;
    const defaults = await this.imageDefaults(ctx, previousImageId);

    const unsupported = unreproducibleOptions(raw, defaults, say('workload.update.execEntrypoint'));
    if (unsupported.length > 0) {
      throw new DriverError(
        say('workload.update.unsupported', {
          name: workload.name,
          options: unsupported.join(', '),
        }),
        this.runtime,
        'workload.update',
      );
    }

    const name = workload.name;
    onLog(`→ docker pull ${image}`);
    await this.stream(
      ctx,
      `docker pull ${shellQuote(image)}`,
      onLog,
      'workload.update',
      PULL_TIMEOUT_MS,
    );

    const pulled = await exec(
      ctx.sshSession,
      `docker image inspect --format '{{.Id}}' ${shellQuote(image)}`,
      { timeout: SHORT_TIMEOUT_MS },
    );
    const newImageId = firstLine(pulled.stdout);
    onLog(
      newImageId && newImageId === previousImageId
        ? say('workload.update.upToDate')
        : say('workload.update.updated', {
            from: shortId(previousImageId),
            to: shortId(newImageId ?? '?'),
          }),
    );

    const wasRunning = workload.state === 'running' || workload.state === 'restarting';
    const backup = `${name}-tp-prev-${Date.now()}`;
    const createArgs = renderCreateArgs(raw, defaults, name);
    const extraNetworks = extraNetworkNames(raw);

    onLog(say('workload.update.setAside', { backup }));
    await this.run(
      ctx,
      `docker rename ${shellQuote(ref.id)} ${shellQuote(backup)}`,
      onLog,
      'workload.update',
    );
    await this.run(ctx, `docker stop -t 20 ${shellQuote(backup)}`, onLog, 'workload.update');

    try {
      onLog(`→ docker create --name ${name}`);
      await this.stream(
        ctx,
        `docker ${createArgs.map(shellQuote).join(' ')}`,
        onLog,
        'workload.update',
        REMOVE_TIMEOUT_MS,
      );

      for (const network of extraNetworks) {
        onLog(say('workload.update.network', { network }));
        await this.run(
          ctx,
          `docker network connect ${shellQuote(network)} ${shellQuote(name)}`,
          onLog,
          'workload.update',
        );
      }

      if (wasRunning) {
        await this.run(ctx, `docker start ${shellQuote(name)}`, onLog, 'workload.update');
        onLog(say('workload.update.restarted'));
      } else {
        // A stopped workload stays stopped: the update does not decide in place of
        // whoever stopped it.
        onLog(say('workload.update.leftStopped'));
      }
    } catch (error) {
      onLog(say('workload.update.rollingBack'));
      // Cleanup must not hide the original failure: it is attempted on a best-effort
      // basis, and the initial error is the one that comes up.
      await this.tryQuietly(ctx, `docker rm -f ${shellQuote(name)}`);
      await this.tryQuietly(ctx, `docker rename ${shellQuote(backup)} ${shellQuote(name)}`);
      if (wasRunning) await this.tryQuietly(ctx, `docker start ${shellQuote(name)}`);
      throw error;
    }

    await this.tryQuietly(ctx, `docker rm -f ${shellQuote(backup)}`);
    onLog(say('workload.update.oldRemoved'));
  }

  /** Reads a workload again on the machine, and refuses to act blindly. */
  /**
   * By the project label rather than `docker compose ps`: the release may have
   * been pruned, the project exists as long as its containers do. Stopped
   * containers count — their image is still the deployed one. `RepoDigests`
   * carries the index digest when the image was pulled by tag.
   */
  async runningImages(ctx: DriverContext): Promise<RunningImage[]> {
    const containers = await exec(
      ctx.sshSession,
      `ids=$(docker ps -aq --filter label=${COMPOSE_PROJECT_LABEL}=${shellQuote(this.project(ctx))}); ` +
        `[ -z "$ids" ] || docker inspect --format ` +
        `'{{index .Config.Labels "${COMPOSE_SERVICE_LABEL}"}} {{.Image}}' $ids`,
      { timeout: SHORT_TIMEOUT_MS, logOutput: false },
    );
    if (containers.code !== 0) return [];

    const byService = new Map<string, Set<string>>();
    for (const line of containers.stdout.split('\n')) {
      const [service, imageId] = line.trim().split(/\s+/);
      if (!service || !imageId) continue;
      const ids = byService.get(service) ?? new Set<string>();
      ids.add(imageId);
      byService.set(service, ids);
    }
    const imageIds = [...new Set([...byService.values()].flatMap((ids) => [...ids]))];
    if (imageIds.length === 0) return [];

    const inspected = await exec(
      ctx.sshSession,
      `docker image inspect --format '{{.Id}} {{json .RepoDigests}}' ${imageIds.map(shellQuote).join(' ')}`,
      { timeout: SHORT_TIMEOUT_MS, logOutput: false },
    );
    const digests = parseRepoDigests(inspected.stdout);

    return [...byService].map(([service, ids]) => ({
      service,
      digests: [...new Set([...ids].flatMap((id) => digests.get(id) ?? []))],
    }));
  }

  /** The real Docker name of an application volume: Compose prefixes it with the project. */
  private async dockerVolume(ctx: DriverContext, service: string, volume: string): Promise<string> {
    const key = volumeName(ctx.appSlug, service, volume);
    const result = await exec(
      ctx.sshSession,
      `docker volume ls -q --filter label=${COMPOSE_PROJECT_LABEL}=${shellQuote(this.project(ctx))} ` +
        `--filter label=com.docker.compose.volume=${shellQuote(key)}`,
      { timeout: SHORT_TIMEOUT_MS, logOutput: false },
    );
    const name = result.stdout.trim().split('\n')[0]?.trim();
    if (result.code !== 0 || !name) {
      throw new DriverError(
        this.say(ctx)('backup.volumeMissing', { volume, service }),
        this.runtime,
        'backup',
      );
    }
    return name;
  }

  /** The running container of an application service. */
  private async serviceContainer(ctx: DriverContext, service: string): Promise<string> {
    const result = await exec(
      ctx.sshSession,
      `docker ps -q --filter label=${COMPOSE_PROJECT_LABEL}=${shellQuote(this.project(ctx))} ` +
        `--filter label=${COMPOSE_SERVICE_LABEL}=${shellQuote(service)}`,
      { timeout: SHORT_TIMEOUT_MS, logOutput: false },
    );
    const id = result.stdout.trim().split('\n')[0]?.trim();
    if (result.code !== 0 || !id) {
      throw new DriverError(
        this.say(ctx)('backup.serviceDown', { service }),
        this.runtime,
        'backup',
      );
    }
    return id;
  }

  private async pipeOrFail(
    ctx: DriverContext,
    command: string,
    step: string,
    streams: { stdout?: Writable; stdin?: Readable },
  ): Promise<void> {
    const say = driverSay(ctx.language);
    const result = await execPipe(ctx.sshSession, command, streams);
    if (result.timedOut) throw new DriverError(say('step.timeout', { step }), this.runtime, step);
    if (result.code !== 0) {
      throw new DriverError(
        say('step.failed', {
          step,
          code: result.code,
          detail: lastLine(result.stderr) ?? say('step.noDetail'),
        }),
        this.runtime,
        step,
      );
    }
  }

  /**
   * An ephemeral `busybox` container, without network, mounts the volume
   * read-only and writes its archive: the volume can be read even with the
   * application stopped, and the application's image does not need `tar`.
   */
  async exportVolume(
    ctx: DriverContext,
    service: string,
    volume: string,
    sink: Writable,
  ): Promise<void> {
    const name = await this.dockerVolume(ctx, service, volume);
    await this.pipeOrFail(
      ctx,
      `docker run --rm --network none -v ${shellQuote(`${name}:/data:ro`)} ${BACKUP_HELPER_IMAGE} ` +
        'tar czf - -C /data .',
      'backup.volume',
      { stdout: sink },
    );
  }

  async importVolume(
    ctx: DriverContext,
    service: string,
    volume: string,
    source: Readable,
  ): Promise<void> {
    const name = await this.dockerVolume(ctx, service, volume);
    await this.pipeOrFail(
      ctx,
      `docker run --rm -i --network none -v ${shellQuote(`${name}:/data`)} ${BACKUP_HELPER_IMAGE} ` +
        `sh -c ${shellQuote(CLEAR_AND_EXTRACT)}`,
      'restore.volume',
      { stdin: source },
    );
  }

  async exportFromService(
    ctx: DriverContext,
    service: string,
    command: string,
    sink: Writable,
  ): Promise<void> {
    const id = await this.serviceContainer(ctx, service);
    await this.pipeOrFail(
      ctx,
      `docker exec ${shellQuote(id)} sh -c ${shellQuote(command)}`,
      'backup.dump',
      {
        stdout: sink,
      },
    );
  }

  async importIntoService(
    ctx: DriverContext,
    service: string,
    command: string,
    source: Readable,
  ): Promise<void> {
    const id = await this.serviceContainer(ctx, service);
    await this.pipeOrFail(
      ctx,
      `docker exec -i ${shellQuote(id)} sh -c ${shellQuote(command)}`,
      'restore.dump',
      { stdin: source },
    );
  }

  /**
   * `docker start`, `docker stop`, `docker restart` — the container itself,
   * nothing recreated, nothing deleted. The stop gives the process twenty seconds
   * to finish cleanly before SIGKILL, like `compose down`.
   */
  async controlWorkload(
    ctx: TargetContext,
    ref: WorkloadRef,
    action: WorkloadControlAction,
    onLog: LogSink,
  ): Promise<void> {
    const step = `workload.${action}`;
    const { workload } = await this.findWorkload(ctx, ref, step);
    if (workload.managed && action !== 'restart') {
      throw new DriverError(
        managedWorkloadControlRefusal(workload, ctx.language),
        this.runtime,
        step,
      );
    }
    if (!workload.controls.includes(action)) {
      throw new DriverError(
        this.say(ctx)('workload.control.invalid', {
          name: workload.name,
          state: workload.state,
          action,
        }),
        this.runtime,
        step,
      );
    }
    const command = {
      start: `docker start ${shellQuote(ref.id)}`,
      stop: `docker stop -t 20 ${shellQuote(ref.id)}`,
      restart: `docker restart -t 20 ${shellQuote(ref.id)}`,
    }[action];
    onLog(`→ ${command.replace(shellQuote(ref.id), workload.name)}`);
    await this.stream(ctx, command, onLog, step, REMOVE_TIMEOUT_MS);
    onLog(this.say(ctx)('workload.control.done', { name: workload.name, action }));
  }

  async workloadLogs(
    ctx: TargetContext,
    ref: WorkloadRef,
    tail: number,
    onLine: LogSink,
  ): Promise<void> {
    await this.findWorkload(ctx, ref, 'workload.logs');
    // `2>&1`: a container writes as much to stderr as to stdout, and the log reads
    // in the order it was written.
    await this.stream(
      ctx,
      `docker logs --timestamps --tail ${Math.max(1, Math.floor(tail))} ${shellQuote(ref.id)} 2>&1`,
      onLine,
      'workload.logs',
      SHORT_TIMEOUT_MS,
    );
  }

  async execInWorkload(
    ctx: TargetContext,
    ref: WorkloadRef,
    command: string,
    onLine: LogSink,
    options: WorkloadExecOptions,
  ): Promise<WorkloadExecResult> {
    const { workload } = await this.findWorkload(ctx, ref, 'workload.exec');
    if (!workload.exec) {
      throw new DriverError(
        this.say(ctx)('workload.exec.notRunning', { name: workload.name }),
        this.runtime,
        'workload.exec',
      );
    }
    return runBoundedExec(
      ctx.sshSession,
      `docker exec ${shellQuote(ref.id)} sh -c ${quoteForShell(command)} 2>&1`,
      onLine,
      options,
    );
  }

  private async findWorkload(
    ctx: TargetContext,
    ref: WorkloadRef,
    step: string,
  ): Promise<{ raw: DockerInspect; workload: Workload }> {
    const result = await exec(ctx.sshSession, `docker inspect ${shellQuote(ref.id)}`, {
      timeout: SHORT_TIMEOUT_MS,
      logOutput: false,
    });

    const [raw] = result.code === 0 ? parseInspect(result.stdout) : [];
    if (!raw) {
      throw new DriverError(this.say(ctx)('workload.notFound', { id: ref.id }), this.runtime, step);
    }

    return { raw, workload: toWorkload(raw, new Map()) };
  }

  /** An image's default configuration, to tell the explicit from the inherited. */
  private async imageDefaults(ctx: TargetContext, imageId: string): Promise<ImageDefaults> {
    const result = await exec(ctx.sshSession, `docker image inspect ${shellQuote(imageId)}`, {
      timeout: SHORT_TIMEOUT_MS,
      logOutput: false,
    });
    return result.code === 0 ? parseImageDefaults(result.stdout) : EMPTY_IMAGE_DEFAULTS;
  }

  /** Emergency recovery: we try, we do not fail on it. */
  private async tryQuietly(ctx: TargetContext, command: string): Promise<void> {
    try {
      await exec(ctx.sshSession, command, { timeout: SHORT_TIMEOUT_MS, logOutput: false });
    } catch {
      // Nothing to save: the error that counts is the one that led us here.
    }
  }

  // ─── execution ──────────────────────────────────────────────────────────────

  private async run(
    ctx: TargetContext,
    command: string,
    onLog: LogSink,
    step: string,
  ): Promise<void> {
    const result = await exec(ctx.sshSession, command, { timeout: SHORT_TIMEOUT_MS });
    if (result.code !== 0) {
      const detail = firstLine(result.stderr) ?? `code ${result.code}`;
      onLog(`✗ ${detail}`);
      throw new DriverError(
        driverSay(ctx.language)('command.failed', { command, detail }),
        this.runtime,
        step,
      );
    }
  }

  private async stream(
    ctx: TargetContext,
    command: string,
    onLog: LogSink,
    step: string,
    timeout: number,
    failOnError = true,
  ): Promise<void> {
    const result = await execStream(ctx.sshSession, command, (line) => onLog(line), {
      timeout,
      logOutput: false,
    });

    const say = driverSay(ctx.language);
    if (result.timedOut) {
      throw new DriverError(say('step.timeout', { step }), this.runtime, step);
    }
    if (failOnError && result.code !== 0) {
      throw new DriverError(
        say('step.failed', {
          step,
          code: result.code,
          detail: firstLine(result.stderr) ?? say('step.noDetail'),
        }),
        this.runtime,
        step,
      );
    }
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Last non-empty line — where a tool says why it stops. */
function lastLine(value: string): string | null {
  const lines = value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) ?? null;
}

/**
 * The image of backup operations on the target: what it takes to run `tar`,
 * nothing else. Pulled once, a few hundred kilobytes.
 */
const BACKUP_HELPER_IMAGE = 'busybox:1.37';

/** Empties the volume — hidden files included —, then extracts the archive read on stdin. */
const CLEAR_AND_EXTRACT = 'cd /data && rm -rf -- * .[!.]* ..?* 2>/dev/null; tar xzf - -C /data';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


/** Fourth column of `df -Pk`, converted to MiB. */
function parseAvailableMi(output: string): number | null {
  const lines = output.trim().split('\n');
  const row = lines[lines.length - 1];
  if (!row || lines.length < 2) return null;

  const columns = row.trim().split(/\s+/);
  const availableKb = Number.parseInt(columns[3] ?? '', 10);
  return Number.isNaN(availableKb) ? null : Math.floor(availableKb / 1024);
}

/** `docker compose ps --format json`: one object per line, or an array. */
function countRunning(output: string): number {
  const trimmed = output.trim();
  if (trimmed.length === 0) return 0;

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed.length;
  } catch {
    // "JSON Lines" format depending on the Compose version.
  }

  return trimmed.split('\n').filter((line) => line.trim().startsWith('{')).length;
}

/** States reported by Compose, brought back to monitoring's neutral vocabulary. */
function toServiceState(raw: string): ServiceState {
  const value = raw.toLowerCase();
  if (value.includes('running')) return 'running';
  if (value.includes('restarting')) return 'restarting';
  if (value.includes('exited') || value.includes('dead')) return 'exited';
  if (value.includes('paused')) return 'paused';
  if (value.includes('created')) return 'created';
  return 'unknown';
}

function toHealth(raw: string): ServiceStatus['health'] {
  const value = raw.toLowerCase();
  if (value.includes('unhealthy')) return 'unhealthy';
  if (value.includes('starting')) return 'starting';
  if (value.includes('healthy')) return 'healthy';
  return 'none';
}

type ComposePsRow = {
  Service?: unknown;
  Name?: unknown;
  State?: unknown;
  Status?: unknown;
  Health?: unknown;
  Image?: unknown;
  Publishers?: unknown;
};

/** Accepts the JSON array as well as "JSON Lines", depending on the Compose version. */
function parseComposePs(output: string): ServiceStatus[] {
  const trimmed = output.trim();
  if (trimmed.length === 0) return [];

  const rows: ComposePsRow[] = [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) rows.push(...(parsed as ComposePsRow[]));
    else if (parsed && typeof parsed === 'object') rows.push(parsed as ComposePsRow);
  } catch {
    for (const line of trimmed.split('\n')) {
      const candidate = line.trim();
      if (!candidate.startsWith('{')) continue;
      try {
        rows.push(JSON.parse(candidate) as ComposePsRow);
      } catch {
        // Truncated line: we skip it rather than fail on the whole batch.
      }
    }
  }

  return rows.map((row) => {
    const status = typeof row.Status === 'string' ? row.Status : '';
    const ports =
      typeof row.Publishers === 'string'
        ? [row.Publishers]
        : Array.isArray(row.Publishers)
          ? row.Publishers.map((p) => {
              const entry = p as { PublishedPort?: number; TargetPort?: number };
              return entry.PublishedPort && entry.TargetPort
                ? `${entry.PublishedPort}→${entry.TargetPort}`
                : '';
            }).filter((value) => value.length > 0)
          : [];

    return {
      name: typeof row.Service === 'string' ? row.Service : String(row.Name ?? 'inconnu'),
      state: toServiceState(typeof row.State === 'string' ? row.State : status),
      health: toHealth(typeof row.Health === 'string' && row.Health ? row.Health : status),
      since: status.length > 0 ? status : null,
      image: typeof row.Image === 'string' ? row.Image : null,
      // Deduplicated: Compose declares one publication per address family, so that a
      // single `30004:80` comes out twice — once for 0.0.0.0, once for ::. The screen
      // showed "30004→80, 30004→80", which reads as two publications when there is
      // only one.
      ports: [...new Set(ports)],
    };
  });
}

/** Type guard for the spec, useful to callers. */
export function hasBuildableService(spec: AppSpec): boolean {
  return spec.services.some((service) => service.source.type === 'dockerfile');
}

// ─── the target's workloads: reading Docker ───────────────────────────────────

/**
 * Labels the Compose render sets on each service (`docker/render.ts`).
 * Declared again here rather than imported: they are the *fingerprints* the
 * driver looks for on the machine, not the values it writes.
 */
const MANAGED_LABEL = 'pupitre.managed-by';
const MANAGED_VALUE = 'pupitre';

/**
 * The fingerprint from before the renaming, still read.
 *
 * A container deployed yesterday carries `tp.managed-by: bootstrap-tp-v2` and
 * is still running. Only recognizing the new fingerprint would make it pass for
 * a foreign workload: the workloads screen would stop saying "managed by the
 * panel", and would offer to delete it by hand. A renaming must not make the
 * panel lose track of what it set up itself.
 *
 * These two constants will go away when no target carries a container from
 * before the renaming anymore — that is, never in a verifiable way, which is why
 * they stay.
 */
const LEGACY_MANAGED_LABEL = 'tp.managed-by';
const LEGACY_MANAGED_VALUE = 'bootstrap-tp-v2';

const APP_LABEL = 'pupitre.app';
const LEGACY_APP_LABEL = 'tp.app';
const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service';

type DockerPortBinding = { HostIp?: string; HostPort?: string };

type DockerInspect = {
  Id?: string;
  Name?: string;
  Created?: string;
  Image?: string;
  State?: { Status?: string; Health?: { Status?: string } };
  Config?: {
    Image?: string;
    Labels?: Record<string, string> | null;
    Env?: string[] | null;
    Cmd?: string[] | null;
    Entrypoint?: string[] | null;
    User?: string;
    WorkingDir?: string;
    Tty?: boolean;
    OpenStdin?: boolean;
  };
  HostConfig?: {
    RestartPolicy?: { Name?: string; MaximumRetryCount?: number };
    PortBindings?: Record<string, DockerPortBinding[] | null> | null;
    Binds?: string[] | null;
    NetworkMode?: string;
    Privileged?: boolean;
    CapAdd?: string[] | null;
    CapDrop?: string[] | null;
    Devices?: unknown[] | null;
    ExtraHosts?: string[] | null;
    Ulimits?: unknown[] | null;
    GroupAdd?: string[] | null;
    Sysctls?: Record<string, string> | null;
    Tmpfs?: Record<string, string> | null;
  };
  NetworkSettings?: {
    Ports?: Record<string, DockerPortBinding[] | null> | null;
    Networks?: Record<string, unknown> | null;
  };
  Mounts?: Array<{ Type?: string; Name?: string; Destination?: string; RW?: boolean }>;
};

/** What the image brings by itself, and which must therefore not be copied. */
type ImageDefaults = {
  env: string[];
  labels: Record<string, string>;
  cmd: string[] | null;
  entrypoint: string[] | null;
  workingDir: string | null;
  user: string | null;
};

const EMPTY_IMAGE_DEFAULTS: ImageDefaults = {
  env: [],
  labels: {},
  cmd: null,
  entrypoint: null,
  workingDir: null,
  user: null,
};

function shortId(value: string): string {
  return value.replace(/^sha256:/, '').slice(0, 12);
}

function sameList(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** `docker ps -a --no-trunc --format '{{.ID}} {{.Status}}'` → id → "Up 2 hours". */
function parsePsStatuses(output: string): Map<string, string> {
  const statuses = new Map<string, string>();
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const space = trimmed.indexOf(' ');
    if (space <= 0) continue;
    statuses.set(trimmed.slice(0, space), trimmed.slice(space + 1).trim());
  }
  return statuses;
}

/** `docker inspect`: a JSON array, preceded by the session's possible noise. */
function parseInspect(output: string): DockerInspect[] {
  const start = output.indexOf('[');
  if (start < 0) return [];
  try {
    const parsed: unknown = JSON.parse(output.slice(start));
    return Array.isArray(parsed) ? (parsed as DockerInspect[]) : [];
  } catch {
    return [];
  }
}

function parseImageDefaults(output: string): ImageDefaults {
  const [image] = parseInspect(output);
  const config = image?.Config;
  if (!config) return EMPTY_IMAGE_DEFAULTS;

  return {
    env: config.Env ?? [],
    labels: config.Labels ?? {},
    cmd: config.Cmd ?? null,
    entrypoint: config.Entrypoint ?? null,
    workingDir: config.WorkingDir ?? null,
    user: config.User ?? null,
  };
}

function publishedPorts(raw: DockerInspect): string[] {
  const ports = raw.NetworkSettings?.Ports ?? {};
  const out: string[] = [];

  for (const [portProto, bindings] of Object.entries(ports)) {
    for (const binding of bindings ?? []) {
      if (!binding.HostPort) continue;
      const host =
        binding.HostIp && binding.HostIp !== '0.0.0.0' && binding.HostIp !== '::'
          ? `${binding.HostIp}:${binding.HostPort}`
          : binding.HostPort;
      const entry = `${host}→${portProto}`;
      if (!out.includes(entry)) out.push(entry);
    }
  }

  return out;
}

/**
 * Inspected container → neutral workload.
 *
 * `managed` has three sources, on purpose: the current fingerprint the panel
 * sets itself, the one from before the renaming to Pupitre, and the `app-`
 * project prefix that catches containers set up by an earlier version of the
 * render. A false negative here would allow deleting a live application.
 */
function toWorkload(raw: DockerInspect, statuses: Map<string, string>): Workload {
  const id = raw.Id ?? '';
  const labels = raw.Config?.Labels ?? {};
  const project = labels[COMPOSE_PROJECT_LABEL] ?? null;
  const fromProject = project !== null && project.startsWith(PROJECT_PREFIX);
  const rawState = raw.State?.Status ?? '';
  const state = toServiceState(rawState);
  const managed =
    labels[MANAGED_LABEL] === MANAGED_VALUE ||
    labels[LEGACY_MANAGED_LABEL] === LEGACY_MANAGED_VALUE ||
    fromProject;

  return {
    runtime: 'docker',
    id,
    name: (raw.Name ?? '').replace(/^\//, '') || shortId(id),
    // A **key**, not a word: "container" here froze the panel's language into data
    // produced by the driver. The label is chosen on reading, in the screen that
    // shows it.
    kind: 'container',
    scope: project,
    image: raw.Config?.Image ?? null,
    state,
    health: toHealth(raw.State?.Health?.Status ?? ''),
    createdAt: raw.Created ?? null,
    since: statuses.get(id) ?? (rawState.length > 0 ? rawState : null),
    ports: publishedPorts(raw),
    managed,
    managedApp:
      labels[APP_LABEL] ??
      labels[LEGACY_APP_LABEL] ??
      (fromProject && project ? project.slice(PROJECT_PREFIX.length) : null),
    controls: containerControls(state, managed),
    exec: state === 'running',
  };
}

/**
 * What a container accepts in its state: `docker stop` on a stopped container
 * does nothing useful, `docker restart` on a paused container fails. A panel
 * workload can only restart — stopping it belongs to the application.
 */
export function containerControls(state: ServiceState, managed: boolean): WorkloadControlAction[] {
  const controls: WorkloadControlAction[] =
    state === 'running' || state === 'restarting'
      ? ['stop', 'restart']
      : state === 'paused'
        ? ['stop']
        : ['start'];
  return managed ? controls.filter((action) => action === 'restart') : controls;
}

/**
 * Creation options the command line cannot reproduce faithfully. Detecting and
 * refusing them beats silently recreating a diminished workload.
 */
function unreproducibleOptions(
  raw: DockerInspect,
  defaults: ImageDefaults,
  execEntrypoint: string,
): string[] {
  const host = raw.HostConfig ?? {};
  const out: string[] = [];

  if (host.Privileged === true) out.push('--privileged');
  if ((host.CapAdd ?? []).length > 0) out.push('--cap-add');
  if ((host.CapDrop ?? []).length > 0) out.push('--cap-drop');
  if ((host.Devices ?? []).length > 0) out.push('--device');
  if ((host.ExtraHosts ?? []).length > 0) out.push('--add-host');
  if ((host.Ulimits ?? []).length > 0) out.push('--ulimit');
  if ((host.GroupAdd ?? []).length > 0) out.push('--group-add');
  if (Object.keys(host.Sysctls ?? {}).length > 0) out.push('--sysctl');
  if (Object.keys(host.Tmpfs ?? {}).length > 0) out.push('--tmpfs');

  const mode = host.NetworkMode ?? '';
  // A container that shares another one's network stack depends on an identifier
  // that may have disappeared: we do not recreate it by guesswork.
  if (mode.startsWith('container:')) out.push('--network container:…');

  const entrypoint = raw.Config?.Entrypoint ?? null;
  // `--entrypoint` takes a single word: an exec form with several elements has no
  // command-line equivalent.
  if (entrypoint && entrypoint.length > 1 && !sameList(entrypoint, defaults.entrypoint)) {
    out.push(execEntrypoint);
  }

  return out;
}

/** Mounts to carry over: the declared binds, plus named or anonymous volumes. */
function volumeArgs(raw: DockerInspect): string[] {
  const out = [...(raw.HostConfig?.Binds ?? [])];

  for (const mount of raw.Mounts ?? []) {
    if (mount.Type !== 'volume' || !mount.Name || !mount.Destination) continue;
    const destination = mount.Destination;
    const covered = out.some((bind) => bind.split(':')[1] === destination);
    if (covered) continue;
    // An anonymous volume carries data the re-creation would lose if it were left
    // aside: we reattach it explicitly by its name.
    out.push(`${mount.Name}:${destination}${mount.RW === false ? ':ro' : ''}`);
  }

  return out;
}

/** The container's main network, as `docker create --network` expects it. */
function primaryNetwork(raw: DockerInspect): string {
  const mode = raw.HostConfig?.NetworkMode ?? 'default';
  return mode === 'default' ? 'bridge' : mode;
}

function extraNetworkNames(raw: DockerInspect): string[] {
  const primary = primaryNetwork(raw);
  return Object.keys(raw.NetworkSettings?.Networks ?? {}).filter((name) => name !== primary);
}

/**
 * Arguments of a `docker create` reproducing the container's **explicit**
 * configuration: everything equal to the image's default value is absent, so
 * that the freshly pulled image can impose its own.
 */
function renderCreateArgs(raw: DockerInspect, defaults: ImageDefaults, name: string): string[] {
  const config = raw.Config ?? {};
  const host = raw.HostConfig ?? {};
  const args = ['create', '--name', name];

  const restart = host.RestartPolicy?.Name ?? '';
  if (restart.length > 0 && restart !== 'no') {
    const retries = host.RestartPolicy?.MaximumRetryCount ?? 0;
    args.push('--restart', restart === 'on-failure' && retries > 0 ? `on-failure:${retries}` : restart);
  }

  const imageEnv = new Set(defaults.env);
  for (const entry of config.Env ?? []) {
    if (!imageEnv.has(entry)) args.push('--env', entry);
  }

  for (const [key, value] of Object.entries(config.Labels ?? {})) {
    if (defaults.labels[key] === value) continue;
    args.push('--label', `${key}=${value}`);
  }

  for (const [portProto, bindings] of Object.entries(host.PortBindings ?? {})) {
    for (const binding of bindings ?? []) {
      const ip = binding.HostIp && binding.HostIp.length > 0 ? `${binding.HostIp}:` : '';
      const hostPort = binding.HostPort ?? '';
      args.push('--publish', hostPort.length > 0 ? `${ip}${hostPort}:${portProto}` : `${ip}${portProto}`);
    }
  }

  for (const volume of volumeArgs(raw)) args.push('--volume', volume);

  const network = primaryNetwork(raw);
  if (network !== 'bridge') args.push('--network', network);

  if (config.User && config.User !== defaults.user) args.push('--user', config.User);
  if (config.WorkingDir && config.WorkingDir !== defaults.workingDir) {
    args.push('--workdir', config.WorkingDir);
  }
  if (config.Tty === true) args.push('--tty');
  if (config.OpenStdin === true) args.push('--interactive');

  const entrypoint = config.Entrypoint ?? null;
  if (entrypoint && entrypoint.length === 1 && !sameList(entrypoint, defaults.entrypoint)) {
    args.push('--entrypoint', entrypoint[0] as string);
  }

  args.push(config.Image ?? '');

  // The command is only carried over if someone set it: otherwise the new image's
  // `CMD` must apply.
  const cmd = config.Cmd ?? null;
  if (cmd && !sameList(cmd, defaults.cmd)) args.push(...cmd);

  return args;
}

/** `sha256:<id> ["nginx@sha256:…"]` per line → image identifier → digests. */
export function parseRepoDigests(output: string): Map<string, string[]> {
  const digests = new Map<string, string[]>();
  for (const line of output.split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const id = line.slice(0, space).trim();
    let repoDigests: unknown;
    try {
      repoDigests = JSON.parse(line.slice(space + 1));
    } catch {
      continue;
    }
    if (!Array.isArray(repoDigests)) continue;
    digests.set(
      id,
      repoDigests
        .map((value) => (typeof value === 'string' ? digestOf(value) : null))
        .filter((value): value is string => value !== null),
    );
  }
  return digests;
}

function isLoopback(address: string): boolean {
  return address === 'localhost' || address === '::1' || address.startsWith('127.');
}

/**
 * The address to probe for a published port, from `docker compose port`:
 * `172.21.0.6:30001` → `172.21.0.6`. Published everywhere (`0.0.0.0`, `[::]`)
 * or unreadable: the loopback.
 */
export function probeHostOf(binding: string | null): string {
  const host = binding?.replace(/:\d+$/, '').replace(/^\[|\]$/g, '') ?? '';
  return host === '' || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
}
