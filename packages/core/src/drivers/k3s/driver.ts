import { exec, execPipe, execStream, upload } from '../../ssh/client.js';
import type { Readable, Writable } from 'node:stream';
import { storedSecretNames, topologicalOrder, type Service } from '../../spec/index.js';
import { backoffMs } from '../backoff.js';
import type { AppStatus, ServiceState, ServiceStatus } from '../../supervision.js';
import { releaseCandidates, releaseName } from '../release.js';
import { pruneReleases } from '../retention.js';
import { buildContextPath, extractSourceArchive } from '../source-archive.js';
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
  type BuilderPruneResult,
  UnhealthyReleaseError,
} from '../types.js';
import { digestOf, parseImageReference } from '../../images/reference.js';
import { checkableImages, type RunningImage } from '../../images/updates.js';
import type { ProxyUpstream } from '../../proxy/model.js';
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
  LEGACY_MANAGED_BY,
  MANAGED_BY,
  MANAGED_SELECTOR,
  MANIFEST_DIR,
  buildableServices,
  builtImageTag,
  entrypointService,
  namespaceFilePath,
  namespaceName,
  PROXY_POLICY_NAME,
  pvcName,
  renderFiles,
} from './render.js';
import {
  BUILDER_DEPLOYMENT,
  BUILDER_IDLE_TTL_MS,
  BUILDER_NAMESPACE,
  BUILDKIT_IMAGE,
  applyManifestCommand,
  buildCommand,
  builderAdmissionProbeManifest,
  builderDeploymentManifest,
  builderNamespaceManifest,
  builderStateCommand,
  deleteIdleBuilderCommand,
  discardTarCommand,
  importCommand,
  K3S_CONTAINERD_ADDRESS,
  K3S_IMAGE_NAMESPACE,
  parseBuilderState,
  pushContextCommand,
  rolloutStatusCommand,
} from './builder.js';
import type { ImageStore } from '../../scan.js';
import { firstLine, shellQuote } from '../../shell.js';
import type { UiLanguage } from '../../i18n.js';
import { k3sSay, type K3sSay } from './messages.js';

/**
 * K3s driver.
 *
 * The exact counterpart of `DockerComposeDriver`: same responsibilities, same
 * contract, same AppSpecs as input. It imports nothing from `packages/db`,
 * nothing from `apps/web`, nothing from Redis — everything arrives through
 * `DriverContext`.
 *
 * Two accepted divergences, and they live **here**, not in the pipeline:
 *
 * - `allocatePort()` returns `null`: in Kubernetes, exposure goes through the
 *   Ingress, not through a host port. The pipeline marks the step "skipped" by
 *   itself, because the driver answered `null`.
 * - the build pushes nothing to a registry: the image is built **in the
 *   cluster**, by a BuildKit the driver sets up there itself, then imported
 *   into the node's containerd. See `builder.ts` for why it is set up this way.
 *
 * Cluster access: `kubectl` **on the target**, over SSH. The kubeconfig never
 * leaves the machine — no Kubernetes client embedded in the panel, exactly as
 * the Docker driver never talks to the daemon remotely.
 */

const BUILD_TIMEOUT_MS = 20 * 60_000;
const APPLY_TIMEOUT_MS = 10 * 60_000;
const ROLLOUT_TIMEOUT = '5m';
const SHORT_TIMEOUT_MS = 30_000;
/** Log lines brought back per pod when the healthcheck fails. */
const DIAGNOSTIC_LINES = 200;
/** Number of pods described in detail: beyond that, the diagnosis becomes unreadable. */
const DIAGNOSTIC_PODS = 5;
const DIAGNOSTIC_TIMEOUT_MS = 60_000;
/**
 * Waiting for the pods to disappear after scaling to zero replicas. Two minutes
 * in all: enough to let a default `terminationGracePeriodSeconds` (30 s) elapse
 * several times without tying up a worker slot.
 */
const DRAIN_ATTEMPTS = 60;
const DRAIN_INTERVAL_SECONDS = 2;

/**
 * K3s writes its kubeconfig to `/etc/rancher/k3s/k3s.yaml` and does not install
 * it in `$HOME/.kube`. A `KUBECONFIG` already set is respected — a target may
 * aim at a remote cluster — and the K3s path is the fallback.
 */
/** The Kubernetes NodePort range, K3s's by default. */
const NODE_PORT_MIN = 30_000;
const NODE_PORT_MAX = 32_767;

const KUBECONFIG_SETUP =
  'if [ -z "${KUBECONFIG:-}" ] && [ -r /etc/rancher/k3s/k3s.yaml ]; ' +
  'then KUBECONFIG=/etc/rancher/k3s/k3s.yaml; export KUBECONFIG; fi';

export class K3sDriver implements DeploymentDriver {
  readonly runtime = 'k3s' as const;

  /** The namespace under which the application is grouped on the target. */
  workspaceName(appSlug: string): string {
    return namespaceName(appSlug);
  }

  /** The exact copy of `destroy()`, to run by hand on the machine. */
  manualCleanup(appSlug: string, rootPath: string): string[] {
    return [
      `kubectl delete namespace ${namespaceName(appSlug)} --ignore-not-found`,
      `rm -rf ${rootPath}/apps/${appSlug}`,
    ];
  }

  /** `/opt/bootstrap/apps/{slug}` */
  private appPath(ctx: DriverContext): string {
    return `${ctx.target.rootPath}/apps/${ctx.appSlug}`;
  }

  /** `/opt/bootstrap/apps/{slug}/{version}-r{number}` — see `releaseName()`. */
  private releasePath(ctx: DriverContext): string {
    return `${this.appPath(ctx)}/${releaseName(ctx.deployment)}`;
  }

  /** `…/{release}/k8s` */
  private manifestPath(ctx: DriverContext): string {
    return `${this.releasePath(ctx)}/${MANIFEST_DIR}`;
  }

  /**
   * The tag of the images this release builds: the release itself. The pods'
   * template therefore changes at each deployment that builds — the pods are
   * replaced —, and `rollout undo` finds the previous image, not the last one
   * built under the same tag.
   */
  private imageTag(ctx: DriverContext, service: string): string {
    return builtImageTag(ctx.appSlug, service, releaseName(ctx.deployment));
  }

  private namespace(ctx: DriverContext): string {
    return namespaceName(ctx.appSlug);
  }

  /** What the driver says, in the instance's language. */
  private say(ctx: TargetContext): K3sSay {
    return k3sSay(ctx.language);
  }

  /** Shell script preceded by the kubeconfig resolution. */
  private script(lines: string[]): string {
    return [KUBECONFIG_SETUP, ...lines].join('\n');
  }

  private kubectl(args: string): string {
    return this.script([`kubectl ${args}`]);
  }

  /** `kubectl` in the application's namespace. */
  private kube(ctx: DriverContext, args: string): string {
    return this.kubectl(`-n ${this.namespace(ctx)} ${args}`);
  }

  // ─── preflight ──────────────────────────────────────────────────────────────

  async preflight(ctx: DriverContext): Promise<PreflightResult> {
    const say = this.say(ctx);
    const checks: PreflightResult['checks'] = [];

    const nodes = await exec(ctx.sshSession, this.kubectl('get nodes -o json'), {
      timeout: SHORT_TIMEOUT_MS,
    });
    const cluster = nodes.code === 0 ? parseNodes(nodes.stdout) : null;
    const runtimeVersion = cluster?.version ?? null;
    checks.push({
      key: 'cluster',
      label: say('preflight.cluster'),
      ok: cluster !== null && cluster.readyNodes > 0,
      detail:
        cluster === null
          ? (firstLine(nodes.stderr) ?? say('preflight.cluster.unreachable', { code: nodes.code }))
          : say('preflight.cluster.nodes', {
              ready: cluster.readyNodes,
              total: cluster.nodes,
              version: cluster.version ? ` — ${cluster.version}` : '',
            }),
    });

    // Permissions are checked before rendering anything: an `apply` that fails
    // halfway leaves a half-populated namespace.
    const rights = await this.checkRights(ctx);
    checks.push(...rights);

    const ingress = await exec(
      ctx.sshSession,
      this.kubectl("get ingressclass -o jsonpath='{.items[*].metadata.name}'"),
      { timeout: SHORT_TIMEOUT_MS },
    );
    const classes = ingress.code === 0 ? ingress.stdout.trim() : '';
    // Information, plus a condition: domains go through the target's reverse
    // proxy, and it is its connection that says whether it is there.
    checks.push({
      key: 'ingress_controller',
      label: say('preflight.ingress'),
      ok: true,
      detail:
        classes.length > 0
          ? say('preflight.ingress.classes', { classes: classes.split(/\s+/).join(', ') })
          : say('preflight.ingress.none'),
    });

    const disk = await exec(
      ctx.sshSession,
      `df -Pk ${shellQuote(ctx.target.rootPath)} 2>/dev/null || df -Pk /`,
      { timeout: SHORT_TIMEOUT_MS },
    );
    const availableDiskMi = parseAvailableMi(disk.stdout);
    checks.push({
      key: 'disk',
      label: say('preflight.disk'),
      ok: availableDiskMi !== null && availableDiskMi >= 1024,
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

    checks.push(await this.checkBuildCapability(ctx));

    return {
      ok: checks.every((check) => check.ok),
      runtimeVersion,
      availableDiskMi,
      checks,
    };
  }

  /** `kubectl auth can-i` — the only authoritative answer on permissions. */
  private async checkRights(ctx: DriverContext): Promise<PreflightResult['checks']> {
    const say = this.say(ctx);
    const verbs: Array<{ key: string; label: string; args: string }> = [
      {
        key: 'can_create_namespace',
        label: say('preflight.canCreateNamespace'),
        args: 'auth can-i create namespaces',
      },
      {
        key: 'can_create_deployment',
        label: say('preflight.canCreateDeployment'),
        args: `auth can-i create deployments -n ${this.namespace(ctx)}`,
      },
    ];

    const checks: PreflightResult['checks'] = [];
    for (const verb of verbs) {
      const result = await exec(ctx.sshSession, this.kubectl(verb.args), {
        timeout: SHORT_TIMEOUT_MS,
      });
      const allowed = firstLine(result.stdout) === 'yes';
      checks.push({
        key: verb.key,
        label: verb.label,
        ok: allowed,
        detail: allowed
          ? say('preflight.yes')
          : (firstLine(result.stdout) ?? firstLine(result.stderr) ?? say('preflight.no')),
      });
    }
    return checks;
  }

  /**
   * Will this cluster accept to build the images the AppSpec asks for?
   *
   * The question is asked **at preflight**, not at the `build` step. The timing
   * is the whole point: `build` comes after `upload`, hence after the manifests —
   * rendered Secrets in clear included — have been placed on the target. A
   * refusal at that moment leaves behind exactly what we were trying not to put
   * there. The preflight already has the AppSpec at hand and has written nothing
   * yet.
   *
   * We do not ask the cluster whether it is "capable" in the abstract: we submit
   * the builder to it with `--dry-run=server`, and take its answer. It is the
   * only authoritative one — it goes through the same RBAC and the same
   * admission control as what we will really create, PodSecurity included, which
   * is what would refuse the privileged pod BuildKit needs.
   */
  private async checkBuildCapability(
    ctx: DriverContext,
  ): Promise<PreflightResult['checks'][number]> {
    const say = this.say(ctx);
    const label = say('preflight.build');
    const buildable = buildableServices(ctx.spec);
    if (buildable.length === 0) {
      return {
        key: 'image_build',
        label,
        ok: true,
        detail: say('preflight.build.none'),
      };
    }

    const names = buildable.map((service) => say('quoted', { name: service.name })).join(', ');

    // The namespace is created for real, not as a dry run: a `--dry-run=server`
    // on a Deployment whose namespace does not exist answers "namespaces not
    // found" — that is, nothing about permissions or admission. Measured on the
    // test target. An empty namespace is a trace out of all proportion with the
    // rendered Secrets this check avoids writing on the machine.
    const namespace = await exec(
      ctx.sshSession,
      this.script([applyManifestCommand(builderNamespaceManifest())]),
      { timeout: SHORT_TIMEOUT_MS },
    );
    if (namespace.code !== 0) {
      return {
        key: 'image_build',
        label,
        ok: false,
        detail: say('preflight.build.namespaceRefused', {
          names,
          namespace: BUILDER_NAMESPACE,
          detail: firstLine(namespace.stderr) ?? `code ${namespace.code}`,
        }),
      };
    }

    // The Deployment for permissions and schema, the Pod for admission:
    // PodSecurity validates Pods, and settles for a warning on a controller. Both,
    // or the check only proves half.
    const admission = await exec(
      ctx.sshSession,
      // `set -e`: without it, the exit code would be the last `apply`'s, and a
      // refusal on the first one would pass for a success.
      this.script([
        'set -e',
        applyManifestCommand(builderDeploymentManifest(new Date()), true),
        applyManifestCommand(builderAdmissionProbeManifest(), true),
      ]),
      { timeout: SHORT_TIMEOUT_MS },
    );

    return {
      key: 'image_build',
      label,
      ok: admission.code === 0,
      detail:
        admission.code === 0
          ? say('preflight.build.accepted', {
              names,
              image: BUILDKIT_IMAGE,
              namespace: BUILDER_NAMESPACE,
            })
          : say('preflight.build.refused', {
              names,
              image: BUILDKIT_IMAGE,
              detail: firstLine(admission.stderr) ?? `code ${admission.code}`,
            }),
    };
  }

  /**
   * Makes sure the driver's root is writable by the deployment account. Same as
   * the Docker driver: `/opt` belongs to root on a standard machine, the first
   * run needs elevation.
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
    const identity = await exec(ctx.sshSession, 'id -u; id -g', { timeout: SHORT_TIMEOUT_MS });
    const [uid, gid] = identity.stdout
      .trim()
      .split('\n')
      .map((value) => value.trim());
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

    const confirmed = await exec(ctx.sshSession, `test -w ${shellQuote(appPath)}`, {
      timeout: SHORT_TIMEOUT_MS,
    });
    return confirmed.code === 0
      ? { ok: true, detail: this.say(ctx)('workdir.provisioned', { path: appPath }) }
      : { ok: false, detail: this.say(ctx)('workdir.stillReadOnly', { path: appPath }) };
  }

  // ─── allocatePort ───────────────────────────────────────────────────────────

  /**
   * No host port: in Kubernetes, exposure is the Ingress's job. Returning `null`
   * is the driver's answer, not an exception handled elsewhere — the pipeline
   * will mark the step "skipped" by itself.
   */
  /**
   * Usually no port: the cluster's proxy reaches the Service. When the proxy is
   * on **another** machine (`exposure.byPort`), it needs a node port — a
   * NodePort, reserved like a Docker port, in the range Kubernetes accepts.
   */
  async allocatePort(ctx: DriverContext, onLog?: LogSink): Promise<number | null> {
    if (!ctx.exposure?.byPort) return null;
    if (!ctx.portAllocator) {
      throw new DriverError(this.say(ctx)('port.allocatorMissing'), this.runtime, 'allocate_port');
    }
    const key = { targetId: ctx.target.id, applicationId: ctx.applicationId };
    const existing = await ctx.portAllocator.current(key);
    if (existing !== null) return existing;
    const range = {
      min: Math.max(ctx.portRange?.min ?? NODE_PORT_MIN, NODE_PORT_MIN),
      max: Math.min(ctx.portRange?.max ?? NODE_PORT_MAX, NODE_PORT_MAX),
    };
    if (range.min > range.max) {
      throw new DriverError(
        this.say(ctx)('port.nodePortRange', { min: NODE_PORT_MIN, max: NODE_PORT_MAX }),
        this.runtime,
        'allocate_port',
      );
    }
    const port = await ctx.portAllocator.allocate({ ...key, ...range });
    onLog?.(this.say(ctx)('port.nodePort', { port }));
    return port;
  }

  /**
   * The entry point's Service, in the application's namespace; or its NodePort,
   * when a proxy outside the cluster must reach it.
   */
  upstream(ctx: DriverContext, publishedPort: number | null): ProxyUpstream | null {
    if (publishedPort !== null) return { kind: 'port', port: publishedPort };
    const service = entrypointService(ctx.spec);
    return { kind: 'kubernetes', namespace: this.namespace(ctx), service: service.name, port: service.port };
  }

  /** The reserved NodePort, if there is one and it is still wanted. */
  private async publishedPort(ctx: DriverContext): Promise<number | null> {
    if (!ctx.exposure?.byPort || !ctx.portAllocator) return null;
    return ctx.portAllocator.current({ targetId: ctx.target.id, applicationId: ctx.applicationId });
  }

  // ─── render ─────────────────────────────────────────────────────────────────

  async render(ctx: DriverContext): Promise<RenderedArtifacts> {
    // Roots only: an alias has no value of its own to ask for.
    const secretNames = storedSecretNames(ctx.spec);
    const secretValues = ctx.resolveSecrets ? await ctx.resolveSecrets(secretNames) : {};

    const publishedPort = await this.publishedPort(ctx);
    const files = renderFiles({
      spec: ctx.spec,
      appSlug: ctx.appSlug,
      secretValues,
      publishedPort,
      allowFrom: ctx.exposure?.allowFrom ?? null,
      imageTag: releaseName(ctx.deployment),
      language: ctx.language,
    });

    return { projectName: this.namespace(ctx), files, publishedPort };
  }

  // ─── upload ─────────────────────────────────────────────────────────────────

  async upload(ctx: DriverContext, artifacts: RenderedArtifacts, onLog: LogSink): Promise<void> {
    const say = this.say(ctx);
    const release = this.releasePath(ctx);
    onLog(say('upload.release', { namespace: artifacts.projectName, release }));

    const workdir = await this.ensureWorkdir(ctx);
    if (!workdir.ok) {
      throw new DriverError(
        say('upload.workdirUnusable', { detail: workdir.detail ?? say('upload.unknownReason') }),
        this.runtime,
        'upload',
      );
    }
    // `kubectl apply -f k8s/` applies **everything** the folder contains: it must
    // only carry this render's manifests — nothing from a previous deployment of
    // the same version, nothing from a repository.
    await this.run(
      ctx,
      `rm -rf ${shellQuote(this.manifestPath(ctx))} && mkdir -p ${shellQuote(this.manifestPath(ctx))}`,
      onLog,
      'upload',
    );

    // The code of a linked repository goes into `source/`, apart from the manifests.
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

    const files: RenderedFile[] = [...(ctx.additionalFiles ?? []), ...artifacts.files];
    for (const file of files) {
      await this.uploadFile(ctx, release, file, onLog);
    }

    await this.assertBuildContexts(ctx, release, onLog);
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
    // The content is never logged: the Secret manifest carries values.
    onLog(this.say(ctx)('upload.deposited', { path: file.path, bytes: file.content.length }));
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

  // ─── build ──────────────────────────────────────────────────────────────────

  /**
   * Builds in the cluster, then imports into the node's containerd.
   *
   * A frozen project decision: no registry. The image is therefore never pushed
   * anywhere — it is born and lives on the machine that runs it. What the node
   * lacks is a builder: `builder.ts` explains which one we set up, and why that
   * one.
   *
   * `null` when no service is built: the step is then `skipped`.
   */
  async build(ctx: DriverContext, onLog: LogSink): Promise<string[] | null> {
    const buildable = buildableServices(ctx.spec);
    if (buildable.length === 0) return null;

    await this.ensureBuilder(ctx, onLog);

    const release = this.releasePath(ctx);
    const tags: string[] = [];

    for (const service of buildable) {
      const source = service.source;
      if (source.type !== 'dockerfile') continue;
      const tag = this.imageTag(ctx, service.name);
      const context = `${release}/${buildContextPath(source.context, ctx.sourceInRelease)}`;

      onLog(this.say(ctx)('build.sendingContext', { service: service.name }));
      await this.stream(
        ctx,
        this.script([pushContextCommand(context)]),
        onLog,
        'build',
        BUILD_TIMEOUT_MS,
      );

      onLog(`buildctl build ${tag} (${service.name})`);
      await this.stream(
        ctx,
        this.script([buildCommand(tag, source.dockerfile)]),
        onLog,
        'build',
        BUILD_TIMEOUT_MS,
      );

      // Without this import, the image only exists in a tar inside the builder pod:
      // the kubelet would look for it on docker.io and the pod would stay in
      // ImagePullBackOff.
      onLog(`k3s ctr -n k8s.io images import ${tag}`);
      await this.stream(
        ctx,
        this.script([importCommand()]),
        onLog,
        'image_import',
        BUILD_TIMEOUT_MS,
        true,
        true,
      );

      // The tar has done its job; it weighs as much as the image. Deleting it is not
      // blocking: the image is already in containerd at this point.
      await this.stream(
        ctx,
        this.script([discardTarCommand()]),
        onLog,
        'build',
        SHORT_TIMEOUT_MS,
        false,
      );

      tags.push(tag);
    }

    return tags;
  }

  /**
   * Sets up the builder in the cluster, or finds it if it is already there, and
   * stamps this run (`pupitre.io/last-build`).
   *
   * It is not removed after the build, deliberately: its layer cache lives in the
   * pod, and destroying it would download every base image again at each
   * deployment. It belongs to no application — an app's `destroy()` must
   * therefore not take it along. Expiry (`pruneIdleBuilder`) removes it, after 24
   * hours without a build.
   */
  private async ensureBuilder(ctx: DriverContext, onLog: LogSink): Promise<void> {
    const say = this.say(ctx);
    onLog(
      say('builder.ensuring', {
        name: BUILDER_DEPLOYMENT,
        image: BUILDKIT_IMAGE,
        namespace: BUILDER_NAMESPACE,
      }),
    );
    await this.stream(
      ctx,
      this.script([
        applyManifestCommand(builderNamespaceManifest()),
        applyManifestCommand(builderDeploymentManifest(new Date())),
      ]),
      onLog,
      'builder',
      APPLY_TIMEOUT_MS,
    );

    await this.stream(
      ctx,
      this.script([rolloutStatusCommand(ROLLOUT_TIMEOUT)]),
      onLog,
      'builder',
      APPLY_TIMEOUT_MS,
    );

    onLog(say('builder.stays', { hours: BUILDER_IDLE_TTL_MS / 3_600_000 }));
  }

  /**
   * Removes the builder left without a build for 24 hours (`BUILDER_IDLE_TTL_MS`).
   *
   * A read, then a deletion **conditional** on the version read: a build that
   * claims it in between rewrites its date in the same gesture that sets it up
   * (see `builderDeploymentManifest`), the version changes, the API answers
   * `Conflict` and the builder stays. Nothing else is touched: neither the
   * namespace nor the images already imported into containerd.
   */
  async pruneIdleBuilder(
    ctx: TargetContext,
    onLog: LogSink,
    now: Date = new Date(),
  ): Promise<BuilderPruneResult> {
    const say = this.say(ctx);
    const read = await exec(ctx.sshSession, this.script([builderStateCommand()]), {
      timeout: SHORT_TIMEOUT_MS,
      logOutput: false,
    });
    if (read.code !== 0) {
      throw new DriverError(
        say('builder.unreadable', { detail: firstLine(read.stderr) ?? `code ${read.code}` }),
        this.runtime,
        'builder.prune',
      );
    }
    const state = parseBuilderState(read.stdout);
    if (!state) return { outcome: 'absent', lastUsedAt: null };

    const lastUsedAt = state.lastUsedAt.toISOString();
    if (now.getTime() - state.lastUsedAt.getTime() < BUILDER_IDLE_TTL_MS) {
      return { outcome: 'kept', lastUsedAt };
    }

    const removed = await exec(
      ctx.sshSession,
      this.script([deleteIdleBuilderCommand(state.resourceVersion)]),
      { timeout: SHORT_TIMEOUT_MS, logOutput: false },
    );
    if (removed.code === 0) {
      onLog(
        say('builder.removed', {
          name: BUILDER_DEPLOYMENT,
          namespace: BUILDER_NAMESPACE,
          date: lastUsedAt,
        }),
      );
      return { outcome: 'removed', lastUsedAt };
    }
    // A build stamped it between the read and the deletion: it is in use, it stays.
    if (/Conflict/.test(removed.stderr)) {
      onLog(say('builder.claimed', { name: BUILDER_DEPLOYMENT }));
      return { outcome: 'kept', lastUsedAt };
    }
    if (/NotFound|not found/.test(removed.stderr)) return { outcome: 'absent', lastUsedAt: null };
    throw new DriverError(
      say('builder.notRemoved', { detail: firstLine(removed.stderr) ?? `code ${removed.code}` }),
      this.runtime,
      'builder.prune',
    );
  }

  // ─── deploy ─────────────────────────────────────────────────────────────────

  async deploy(ctx: DriverContext, onLog: LogSink): Promise<DeployResult> {
    const release = this.releasePath(ctx);
    const manifests = this.manifestPath(ctx);
    const namespace = this.namespace(ctx);

    // The equivalent of `docker compose pull`: without it, `IfNotPresent` keeps the
    // first content pulled for a tag forever.
    const pulled = await this.pullImages(ctx, onLog);

    // The namespace first, alone: the resources that follow reference it.
    onLog(`kubectl apply — namespace ${namespace}`);
    await this.stream(
      ctx,
      this.kubectl(`apply -f ${shellQuote(`${release}/${namespaceFilePath(ctx.appSlug)}`)}`),
      onLog,
      'apply_namespace',
      APPLY_TIMEOUT_MS,
    );

    onLog(`kubectl apply -f . -n ${namespace}`);
    await this.stream(
      ctx,
      this.kubectl(`apply -f ${shellQuote(manifests)} -n ${namespace}`),
      onLog,
      'apply',
      APPLY_TIMEOUT_MS,
    );
    // `apply` removes nothing: a previous deployment's restriction to a remote proxy
    // would block the cluster's proxy, if it is no longer relevant.
    if (!ctx.exposure?.allowFrom || (await this.publishedPort(ctx)) === null) {
      await this.run(
        ctx,
        this.kube(ctx, `delete networkpolicy ${PROXY_POLICY_NAME} --ignore-not-found`),
        onLog,
        'apply',
      );
    }

    for (const service of topologicalOrder(ctx.spec)) {
      onLog(`kubectl rollout status deployment/${service.name}`);
      try {
        await this.stream(
          ctx,
          this.kube(ctx, `rollout status deployment/${service.name} --timeout=${ROLLOUT_TIMEOUT}`),
          onLog,
          'rollout',
          APPLY_TIMEOUT_MS,
        );
      } catch (error) {
        // `apply` went through: the cluster already carries the new version, and it
        // is that one which does not become ready. The old version's pods still hold
        // the place — but the Deployment only describes the new one, and the first of
        // those pods to fall would be reborn as the new version.
        // Rolling back is the only way out that leaves a known state.
        if (!(error instanceof DriverError)) throw error;
        throw new UnhealthyReleaseError(
          this.say(ctx)('deploy.unhealthy', { service: service.name, detail: error.message }),
          this.runtime,
          'rollout',
          await this.diagnose(ctx, await this.unreadyPods(ctx)),
          error,
        );
      }
    }

    await this.refreshStaleImages(ctx, pulled, onLog);

    // Marks the current release: `rollback()` and `destroy()` use it.
    await this.run(
      ctx,
      `ln -sfn ${shellQuote(release)} ${shellQuote(`${this.appPath(ctx)}/current`)}`,
      onLog,
      'link',
    );

    // Cleanup of old versions, once `current` is up to date — their built images
    // along with them, otherwise the node's disk would fill up.
    const pruned = await pruneReleases(ctx, this.appPath(ctx), onLog);
    await this.removeBuiltImages(ctx, pruned, onLog);

    const url = this.buildUrl(ctx);
    onLog(url ? this.say(ctx)('deploy.appliedAt', { url }) : this.say(ctx)('deploy.applied'));

    return {
      ok: true,
      url,
      publishedPort: null,
      releasePath: release,
      images: await this.images(ctx),
    };
  }

  /**
   * URL through which the application must answer.
   *
   * None, from the driver's point of view: the Service is only reachable from the
   * cluster, and a domain is the business of the reverse proxy, whose step comes
   * next. The driver says so by returning `null` rather than making up a URL that
   * would not answer.
   */
  private buildUrl(_ctx: DriverContext): string | null {
    return null;
  }

  /**
   * Images actually referenced by the manifests.
   *
   * Derived from the AppSpec, not from the cluster: the list must be known before
   * anything runs, so the scanners can analyze it.
   */
  async images(ctx: DriverContext): Promise<string[]> {
    return ctx.spec.services.map((service) =>
      service.source.type === 'image' ? service.source.ref : this.imageTag(ctx, service.name),
    );
  }

  /**
   * k3s's containerd, in the kubelet's namespace: that is where `build()` imports
   * the built images. Its socket is reserved to root.
   */
  imageStore(_ctx: DriverContext): ImageStore {
    return {
      kind: 'containerd',
      address: K3S_CONTAINERD_ADDRESS,
      namespace: K3S_IMAGE_NAMESPACE,
      elevated: true,
    };
  }

  // ─── healthcheck ────────────────────────────────────────────────────────────

  async healthcheck(ctx: DriverContext): Promise<HealthResult> {
    const say = this.say(ctx);
    const service = entrypointService(ctx.spec);
    const { retries, intervalSec, timeoutSec } = service.healthcheck;

    const pods = await exec(ctx.sshSession, this.kube(ctx, 'get pods -o json'), {
      timeout: SHORT_TIMEOUT_MS,
    });
    const readiness = pods.code === 0 ? parsePodReadiness(pods.stdout) : null;
    if (readiness === null || readiness.total === 0) {
      return this.unhealthy(ctx, {
        outcome: 'unreachable',
        attempts: 0,
        statusCode: null,
        detail: say('health.noPod', { namespace: this.namespace(ctx) }),
      });
    }
    if (readiness.ready < readiness.total) {
      return this.unhealthy(
        ctx,
        {
          outcome: 'unreachable',
          attempts: 0,
          statusCode: null,
          detail:
            say('health.podsReady', { ready: readiness.ready, total: readiness.total }) +
            (readiness.pending.length > 0
              ? say('health.waiting', { pods: readiness.pending.join(', ') })
              : ''),
        },
        readiness.pending,
      );
    }

    const probe = this.probeCommand(ctx, service, timeoutSec);
    let lastStatus: number | null = null;
    let lastDetail: string | null = null;
    let lastOutcome: HealthOutcome = 'unreachable';

    for (let attempt = 1; attempt <= retries; attempt += 1) {
      const result = await exec(ctx.sshSession, probe.command, {
        timeout: (timeoutSec + 30) * 1000,
      });

      const status = Number.parseInt(lastNonEmptyLine(result.stdout) ?? '', 10);
      lastStatus = Number.isNaN(status) || status === 0 ? null : status;
      lastOutcome = lastStatus === null ? 'unreachable' : 'unhealthy';
      lastDetail =
        lastStatus !== null
          ? say('health.http', { status: lastStatus, url: probe.label })
          : say('health.unreachable', {
              label: probe.label,
              code: result.code,
              detail: firstLine(result.stderr) ? ` : ${firstLine(result.stderr)}` : '',
            });

      if (lastStatus !== null && lastStatus >= 200 && lastStatus < 400) {
        return {
          healthy: true,
          outcome: 'healthy',
          attempts: attempt,
          statusCode: lastStatus,
          detail: `${probe.label} — ${say('health.podsReady', {
            ready: readiness.ready,
            total: readiness.total,
          })}`,
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
   * Failure result, diagnosis captured **before** returning: a rollback that
   * followed would replace the pods and wipe the scene.
   */
  private async unhealthy(
    ctx: DriverContext,
    partial: Omit<HealthResult, 'healthy' | 'diagnostics'>,
    suspects: readonly string[] = [],
  ): Promise<HealthResult> {
    return {
      healthy: false,
      diagnostics: await this.diagnose(ctx, suspects),
      ...partial,
    };
  }

  /**
   * `kubectl get pods`, then `describe` and `logs` of the pods involved.
   *
   * `describe` before `logs`: a pod that does not start (missing image, unbound
   * volume) has no log to show, and it is the event list that says why.
   */
  private async diagnose(
    ctx: DriverContext,
    suspects: readonly string[],
  ): Promise<string | null> {
    const namespace = this.namespace(ctx);
    const sections: string[] = [];

    const pods = await exec(ctx.sshSession, this.kube(ctx, 'get pods -o wide'), {
      timeout: SHORT_TIMEOUT_MS,
    });
    if (pods.stdout.trim().length > 0) {
      sections.push(`$ kubectl -n ${namespace} get pods -o wide\n${pods.stdout.trim()}`);
    }

    // Without a pod named as involved, we look at those that are not `Running` —
    // the same criterion, applied on the fly.
    const names =
      suspects.length > 0 ? [...suspects] : await this.notRunningPods(ctx);

    for (const name of names.slice(0, DIAGNOSTIC_PODS)) {
      const describe = await exec(ctx.sshSession, this.kube(ctx, `describe pod ${shellQuote(name)}`), {
        timeout: DIAGNOSTIC_TIMEOUT_MS,
      });
      sections.push(
        `$ kubectl -n ${namespace} describe pod ${name}\n${describe.stdout.trim() || describe.stderr.trim()}`,
      );

      const logs = await exec(
        ctx.sshSession,
        this.kube(ctx, `logs ${shellQuote(name)} --all-containers --tail ${DIAGNOSTIC_LINES}`),
        { timeout: DIAGNOSTIC_TIMEOUT_MS },
      );
      const output = `${logs.stdout}\n${logs.stderr}`.trim();
      sections.push(
        `$ kubectl -n ${namespace} logs ${name} --tail ${DIAGNOSTIC_LINES}\n` +
          (output.length > 0 ? output : this.say(ctx)('diagnose.noOutput')),
      );
    }

    return sections.length > 0 ? sections.join('\n\n') : null;
  }

  /**
   * The pods that are not ready — `Running` included, when a readiness probe
   * refuses them: that is the case of a version that starts but does not answer
   * as it should.
   */
  private async unreadyPods(ctx: DriverContext): Promise<string[]> {
    const result = await exec(
      ctx.sshSession,
      this.kube(
        ctx,
        "get pods -o jsonpath='{range .items[*]}{.metadata.name} {.status.phase} " +
          '{.status.containerStatuses[*].ready}{"\\n"}{end}\'',
      ),
      { timeout: SHORT_TIMEOUT_MS },
    );

    return result.stdout
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .filter(
        (columns) =>
          columns.length >= 2 && (columns[1] !== 'Running' || columns.slice(2).includes('false')),
      )
      .map((columns) => columns[0] as string);
  }

  private async notRunningPods(ctx: DriverContext): Promise<string[]> {
    const result = await exec(
      ctx.sshSession,
      this.kube(
        ctx,
        "get pods -o jsonpath='{range .items[*]}{.metadata.name} {.status.phase}{\"\\n\"}{end}'",
      ),
      { timeout: SHORT_TIMEOUT_MS },
    );

    return result.stdout
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .filter((columns) => columns.length === 2 && columns[1] !== 'Running')
      .map((columns) => columns[0] as string);
  }

  /**
   * How to probe the application from the node.
   *
   * Through the Service, always: we open a temporary `port-forward`, probe, close.
   * All in one command — one SSH session per probe, no process left hanging if it
   * is cut. The path through a domain is tested by the `proxy` step, through the
   * reverse proxy: the application's health does not depend on its route.
   */
  private probeCommand(
    ctx: DriverContext,
    service: Service,
    timeoutSec: number,
  ): { command: string; label: string } {
    const path = service.healthcheck.path;

    const namespace = this.namespace(ctx);
    const logFile = `/tmp/tp-portforward-${ctx.deployment.id}.log`;
    const port = service.healthcheck.port ?? service.port;

    return {
      label: `port-forward svc/${service.name}:${port}${path}`,
      command: this.script([
        `rm -f ${shellQuote(logFile)}`,
        // Local port 0: kubectl picks a free one and announces it.
        `kubectl -n ${namespace} port-forward svc/${service.name} :${port} > ${shellQuote(logFile)} 2>&1 &`,
        'PF=$!',
        'LP=""',
        'for _ in 1 2 3 4 5 6 7 8 9 10; do',
        `  LP=$(sed -n 's/.*127\\.0\\.0\\.1:\\([0-9][0-9]*\\).*/\\1/p' ${shellQuote(logFile)} | head -n 1)`,
        '  [ -n "$LP" ] && break',
        '  sleep 1',
        'done',
        'if [ -z "$LP" ]; then',
        '  kill "$PF" 2>/dev/null',
        `  cat ${shellQuote(logFile)} >&2`,
        `  rm -f ${shellQuote(logFile)}`,
        '  exit 97',
        'fi',
        `curl -s -o /dev/null -w '%{http_code}' -m ${timeoutSec} "http://127.0.0.1:$LP${path}"`,
        'CODE=$?',
        'kill "$PF" 2>/dev/null',
        `rm -f ${shellQuote(logFile)}`,
        'exit $CODE',
      ]),
    };
  }

  // ─── rollback ───────────────────────────────────────────────────────────────

  /**
   * `kubectl rollout undo` on each Deployment.
   *
   * A Deployment never updated has only one revision: `undo` then fails,
   * legitimately. In that case we apply the previous version's manifests again if
   * they are still on the target — the same semantics as the Docker driver, which
   * restarts the previous release.
   */
  async rollback(ctx: DriverContext, onLog: LogSink): Promise<void> {
    const say = this.say(ctx);
    const services = topologicalOrder(ctx.spec);
    const failed: string[] = [];

    for (const service of services) {
      onLog(`kubectl rollout undo deployment/${service.name}`);
      const undo = await exec(ctx.sshSession, this.kube(ctx, `rollout undo deployment/${service.name}`), {
        timeout: SHORT_TIMEOUT_MS,
      });
      if (undo.code !== 0) {
        onLog(`  ${firstLine(undo.stderr) ?? `code ${undo.code}`}`);
        failed.push(service.name);
      }
    }

    if (failed.length > 0) {
      const previous = ctx.previousDeployment;
      if (!previous) {
        throw new DriverError(
          say('rollback.noRevision', { services: failed.join(', ') }),
          this.runtime,
          'rollback',
        );
      }

      // The previous release, by its name; otherwise, under the name from before
      // `-r{number}` — a release placed before the update.
      let previousRelease: string | null = null;
      for (const name of releaseCandidates(previous)) {
        const candidate = `${this.appPath(ctx)}/${name}`;
        const exists = await exec(
          ctx.sshSession,
          `test -d ${shellQuote(`${candidate}/${MANIFEST_DIR}`)}`,
          {
            timeout: SHORT_TIMEOUT_MS,
          },
        );
        if (exists.code === 0) {
          previousRelease = candidate;
          break;
        }
      }
      if (!previousRelease) {
        throw new DriverError(
          say('rollback.releaseGone', { release: releaseName(previous), path: this.appPath(ctx) }),
          this.runtime,
          'rollback',
        );
      }
      const manifests = `${previousRelease}/${MANIFEST_DIR}`;

      onLog(say('rollback.reapplying', { release: releaseName(previous) }));
      await this.stream(
        ctx,
        this.kubectl(`apply -f ${shellQuote(manifests)} -n ${this.namespace(ctx)}`),
        onLog,
        'rollback',
        APPLY_TIMEOUT_MS,
      );

      await this.run(
        ctx,
        `ln -sfn ${shellQuote(previousRelease)} ${shellQuote(`${this.appPath(ctx)}/current`)}`,
        onLog,
        'link',
      );
    }

    for (const service of services) {
      await this.stream(
        ctx,
        this.kube(ctx, `rollout status deployment/${service.name} --timeout=${ROLLOUT_TIMEOUT}`),
        onLog,
        'rollback',
        APPLY_TIMEOUT_MS,
      );
    }

    onLog(say('rollback.confirmed'));
  }

  /**
   * The built images of the releases just deleted, removed from containerd. An
   * image still used by a pod is refused: that is intended.
   */
  private async removeBuiltImages(
    ctx: DriverContext,
    releases: readonly string[],
    onLog: LogSink,
  ): Promise<void> {
    const built = ctx.spec.services.filter((service) => service.source.type === 'dockerfile');
    if (releases.length === 0 || built.length === 0) return;
    const tags = releases.flatMap((release) =>
      built.map((service) => builtImageTag(ctx.appSlug, service.name, release)),
    );
    // containerd's socket is only open to root, as for the import.
    await exec(
      ctx.sshSession,
      this.script([`k3s crictl rmi ${tags.map(shellQuote).join(' ')} >/dev/null 2>&1; true`]),
      { timeout: SHORT_TIMEOUT_MS, sudo: true },
    );
    onLog(this.say(ctx)('images.removed', { count: tags.length }));
  }

  // ─── destroy ────────────────────────────────────────────────────────────────

  /** Version retention: see `DeploymentDriver.pruneReleases`. */
  async pruneReleases(ctx: DriverContext, onLog: LogSink, keep?: number): Promise<string[]> {
    return pruneReleases(ctx, this.appPath(ctx), onLog, keep);
  }

  async destroy(ctx: DriverContext, onLog: LogSink): Promise<void> {
    const say = this.say(ctx);
    const namespace = this.namespace(ctx);
    const appPath = this.appPath(ctx);

    onLog(`→ kubectl delete namespace ${namespace}`);
    // Deleting the namespace takes everything it contains, PVCs included.
    // `--ignore-not-found`: destroying an absent app must stay idempotent.
    await this.stream(
      ctx,
      this.kubectl(
        `delete namespace ${namespace} --ignore-not-found --wait=true --timeout=${ROLLOUT_TIMEOUT}`,
      ),
      onLog,
      'destroy',
      APPLY_TIMEOUT_MS,
      false,
    );

    // The images built for the application, imported into containerd: with the
    // namespace gone, nothing uses them anymore, and they would pile up on the
    // node. containerd's socket is only open to root, as for the import.
    onLog(say('destroy.images', { namespace }));
    await exec(
      ctx.sshSession,
      this.script([
        `ids=$(k3s crictl images 2>/dev/null | awk -v p=${shellQuote(`(^|/)${namespace}/`)} '$1 ~ p {print $3}' | sort -u)`,
        '[ -z "$ids" ] || k3s crictl rmi $ids >/dev/null 2>&1; true',
      ]),
      { timeout: SHORT_TIMEOUT_MS, sudo: true },
    );

    onLog(say('destroy.removing', { path: appPath }));
    await this.run(ctx, `rm -rf ${shellQuote(appPath)}`, onLog, 'destroy');

    // A NodePort may have been reserved for a remote proxy: it goes with the namespace.
    if (ctx.portAllocator) {
      const key = { targetId: ctx.target.id, applicationId: ctx.applicationId };
      if ((await ctx.portAllocator.current(key)) !== null) {
        await ctx.portAllocator.release(key);
        onLog(say('destroy.nodePortReleased'));
      }
    }

    onLog(say('destroy.done'));
  }

  // ─── logs ───────────────────────────────────────────────────────────────────

  // ─── supervision ────────────────────────────────────────────────────────────

  /**
   * State of the namespace's pods, brought back to monitoring's neutral
   * vocabulary. A Deployment carries several pods: we report each one's state,
   * prefixed with its Deployment's name, rather than making up an average.
   */
  async status(ctx: DriverContext): Promise<AppStatus> {
    const checkedAt = new Date().toISOString();
    const result = await exec(ctx.sshSession, this.kube(ctx, 'get pods -o json'), {
      timeout: SHORT_TIMEOUT_MS,
      logOutput: false,
    });

    if (result.code !== 0) return { services: [], checkedAt };

    return { services: parsePods(result.stdout, ctx.language), checkedAt };
  }

  /**
   * `kubectl rollout restart` recreates the pods without touching the manifests:
   * same images, same volumes, same Ingress. It is the exact equivalent of
   * `docker compose restart` on the Compose side.
   */
  async restart(ctx: DriverContext, onLog: LogSink): Promise<void> {
    onLog(`kubectl rollout restart -n ${this.namespace(ctx)}`);

    await this.stream(
      ctx,
      this.kube(ctx, `rollout restart deployment -l '${MANAGED_SELECTOR}'`),
      onLog,
      'restart',
      APPLY_TIMEOUT_MS,
    );

    for (const service of ctx.spec.services) {
      await this.stream(
        ctx,
        this.kube(ctx, `rollout status deployment/${service.name} --timeout=5m`),
        onLog,
        'restart',
        APPLY_TIMEOUT_MS,
      );
    }

    onLog(this.say(ctx)('restart.done'));
  }

  /**
   * Stop: `kubectl scale --replicas=0` on the application's Deployments.
   *
   * The counterpart of `docker compose stop`, and the only serious candidate. The
   * other ways to "stop" in Kubernetes delete something: `delete deployment`
   * loses the object and its revision history — hence `rollback()` —,
   * `delete namespace` is `destroy()`. Setting the number of replicas to zero
   * touches neither the manifests, nor the PVCs, nor the Service, nor the
   * Ingress: the controller removes the pods, and that is all.
   *
   * The selector is the same as `restart()`'s and `logs()`'s: it is the panel's
   * signature on the cluster, and it recognizes both generations of labels.
   *
   * The wait is explicit. `rollout status` on a Deployment with zero replicas
   * returns immediately — it observes there is nothing to roll out, not that the
   * pods are gone. A `stop()` that returned while the pods are terminating would
   * let the caller probe an intermediate state and conclude wrongly. We therefore
   * loop on the pod count, which `kubectl wait --for=delete` cannot do cleanly
   * when the list is already empty (it exits with an error on "no matching
   * resources found").
   */
  async stop(ctx: DriverContext, onLog: LogSink): Promise<void> {
    const say = this.say(ctx);
    const namespace = this.namespace(ctx);
    onLog(`kubectl scale --replicas=0 -n ${namespace}`);

    await this.stream(
      ctx,
      this.kube(ctx, `scale deployment -l '${MANAGED_SELECTOR}' --replicas=0`),
      onLog,
      'stop',
      APPLY_TIMEOUT_MS,
    );

    await this.stream(
      ctx,
      this.script([
        `for attempt in $(seq 1 ${DRAIN_ATTEMPTS}); do`,
        `  remaining=$(kubectl -n ${namespace} get pods -l '${MANAGED_SELECTOR}' ` +
          `--no-headers 2>/dev/null | wc -l | tr -d ' ')`,
        `  if [ "$remaining" = "0" ]; then echo ${shellQuote(say('stop.drained'))}; exit 0; fi`,
        `  printf '  %s %s\\n' "$remaining" ${shellQuote(say('stop.draining'))}`,
        `  sleep ${DRAIN_INTERVAL_SECONDS}`,
        'done',
        `echo ${shellQuote(say('stop.drainTimeout'))} >&2`,
        'exit 1',
      ]),
      onLog,
      'stop',
      APPLY_TIMEOUT_MS,
    );

    onLog(say('stop.done'));
  }

  /**
   * Start: each Deployment gets back the number of replicas the AppSpec gives it,
   * service by service.
   *
   * Not a `kubectl apply` of the manifests, although it would restore the replicas
   * too: applying means rewriting the whole objects, hence silently erasing what
   * an operator may have adjusted on the cluster since the deployment. Starting
   * is not redeploying. `scale` only touches the field we set to zero.
   *
   * Service by service and not by selector, because the number of replicas is
   * specific to each service: a selector could only restore one and the same for
   * all. The topological order is `deploy()`'s — a database starts before what
   * queries it.
   */
  async start(ctx: DriverContext, onLog: LogSink): Promise<void> {
    const services = topologicalOrder(ctx.spec);
    onLog(`kubectl scale -n ${this.namespace(ctx)} — ${services.length} service(s)`);

    for (const service of services) {
      await this.stream(
        ctx,
        this.kube(ctx, `scale deployment/${service.name} --replicas=${service.replicas}`),
        onLog,
        'start',
        APPLY_TIMEOUT_MS,
      );
    }

    for (const service of services) {
      await this.stream(
        ctx,
        this.kube(ctx, `rollout status deployment/${service.name} --timeout=${ROLLOUT_TIMEOUT}`),
        onLog,
        'start',
        APPLY_TIMEOUT_MS,
      );
    }

    onLog(this.say(ctx)('start.done'));
  }

  async logs(ctx: DriverContext, onLine: LogSink): Promise<void> {
    await execStream(
      ctx.sshSession,
      this.kube(
        ctx,
        'logs -f --all-containers=true --prefix --tail 200 --max-log-requests 50 ' +
          `-l '${MANAGED_SELECTOR}'`,
      ),
      (line) => onLine(line),
      // A log follow has no natural end: it is the caller that cuts the session when
      // it is done.
      { timeout: null, logOutput: false },
    );
  }

  // ─── the target's workloads ─────────────────────────────────────────────────

  /**
   * Everything running on the cluster.
   *
   * We list the **controllers** (Deployment, StatefulSet, DaemonSet) and the pods
   * that have none, not the controlled pods. It is a decision, not a shortcut:
   * deleting a pod managed by a Deployment deletes nothing — the controller
   * recreates one within a second. A row on which the proposed action has no
   * effect is a row that lies. What we show is therefore what can be acted on.
   *
   * The pods remain the source of the displayed state: `2/3 ready` comes from
   * them.
   */
  async listWorkloads(ctx: TargetContext): Promise<Workload[]> {
    const result = await exec(
      ctx.sshSession,
      this.kubectl('get deployments,statefulsets,daemonsets,pods --all-namespaces -o json'),
      { timeout: SHORT_TIMEOUT_MS, logOutput: false },
    );

    if (result.code !== 0) {
      throw new DriverError(
        this.say(ctx)('workload.inventoryFailed', {
          detail: firstLine(result.stderr) ?? `code ${result.code}`,
        }),
        this.runtime,
        'workload.list',
      );
    }

    return parseWorkloads(result.stdout, ctx.language);
  }

  /**
   * Deletes the designated resource. A controller takes its pods along; a
   * standalone pod leaves nothing behind.
   *
   * PVCs are not touched: they deliberately outlive their controller, exactly
   * like named volumes on the Docker side.
   */
  async removeWorkload(ctx: TargetContext, ref: WorkloadRef, onLog: LogSink): Promise<void> {
    const { workload, resource } = await this.findWorkload(ctx, ref, 'workload.remove');

    if (workload.managed) {
      throw new DriverError(
        managedWorkloadRefusal(workload, ctx.language),
        this.runtime,
        'workload.remove',
      );
    }

    // A guard specific to the runtime: the panel has no business in the namespaces
    // that run the cluster itself. Nothing marks them "managed by the panel", and
    // yet deleting them would break the machine.
    if (SYSTEM_NAMESPACES.has(resource.namespace)) {
      throw new DriverError(
        this.say(ctx)('workload.system.remove', {
          name: workload.name,
          namespace: resource.namespace,
        }),
        this.runtime,
        'workload.remove',
      );
    }

    onLog(`→ kubectl -n ${resource.namespace} delete ${resource.kind}/${resource.name}`);
    await this.stream(
      ctx,
      this.kubectl(
        `-n ${resource.namespace} delete ${resource.kind} ${resource.name} ` +
          `--wait=true --timeout=${ROLLOUT_TIMEOUT}`,
      ),
      onLog,
      'workload.remove',
      APPLY_TIMEOUT_MS,
    );
    onLog(this.say(ctx)('workload.removed'));
  }

  /**
   * Updating, in Kubernetes, means exactly this:
   *
   *   1. `kubectl rollout restart` on the controller — it recreates its pods from
   *      the **same** manifest: same images, same volumes, same service, same
   *      ingress;
   *   2. `kubectl rollout status` to wait for the replacement to take effect, and
   *      fail if the new pods do not start.
   *
   * The image is pulled again from the registry by the kubelet on re-creation
   * when the pull policy allows it — `imagePullPolicy: Always`, or a tag absent
   * from the node. The panel does not change the manifest to force the pull:
   * changing `imagePullPolicy` would be changing the configuration, precisely
   * what this operation promises not to do. It is the accepted difference with
   * Docker, where the `pull` is explicit because nobody else is there to decide.
   *
   * A pod without a controller is not updated: nothing would recreate it.
   */
  async updateWorkload(ctx: TargetContext, ref: WorkloadRef, onLog: LogSink): Promise<void> {
    const say = this.say(ctx);
    const { workload, resource } = await this.findWorkload(ctx, ref, 'workload.update');

    if (workload.managed) {
      throw new DriverError(
        say('workload.update.managed', { name: workload.name }),
        this.runtime,
        'workload.update',
      );
    }

    if (resource.kind === 'pod') {
      throw new DriverError(
        say('workload.update.pod', { name: workload.name }),
        this.runtime,
        'workload.update',
      );
    }

    const path = `${resource.kind}/${resource.name}`;
    onLog(`→ kubectl -n ${resource.namespace} rollout restart ${path}`);
    await this.stream(
      ctx,
      this.kubectl(`-n ${resource.namespace} rollout restart ${path}`),
      onLog,
      'workload.update',
      APPLY_TIMEOUT_MS,
    );

    onLog(`→ kubectl -n ${resource.namespace} rollout status ${path}`);
    await this.stream(
      ctx,
      this.kubectl(`-n ${resource.namespace} rollout status ${path} --timeout=${ROLLOUT_TIMEOUT}`),
      onLog,
      'workload.update',
      APPLY_TIMEOUT_MS,
    );
    onLog(say('workload.update.done'));
  }

  async runningImages(ctx: DriverContext): Promise<RunningImage[]> {
    const result = await exec(ctx.sshSession, this.kube(ctx, 'get pods -o json'), {
      timeout: SHORT_TIMEOUT_MS,
      logOutput: false,
    });
    return result.code === 0 ? parsePodImages(result.stdout) : [];
  }

  // ─── sauvegardes ────────────────────────────────────────────────────────────

  private async pipeOrFail(
    ctx: DriverContext,
    command: string,
    step: string,
    streams: { stdout?: Writable; stdin?: Readable },
  ): Promise<void> {
    const say = this.say(ctx);
    const result = await execPipe(ctx.sshSession, this.script([command]), streams);
    if (result.timedOut) throw new DriverError(say('step.timeout', { step }), this.runtime, step);
    if (result.code !== 0) {
      const lines = result.stderr
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      throw new DriverError(
        say('step.failed', {
          step,
          code: result.code,
          detail: lines.at(-1) ?? say('step.noDetail'),
        }),
        this.runtime,
        step,
      );
    }
  }

  /**
   * An ephemeral pod mounts the volume's PVC and takes the archive out of it — or
   * extracts the one it is given into it. The scheduler places it by itself on
   * the volume's node (`local-path` is `ReadWriteOnce`: per node, not per pod).
   * The pod is **always** deleted, on success or failure.
   */
  private async withVolumePod<T>(
    ctx: DriverContext,
    service: string,
    volume: string,
    readOnly: boolean,
    run: (pod: string) => Promise<T>,
  ): Promise<T> {
    const namespace = this.namespace(ctx);
    const pod = `pupitre-backup-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const manifest = JSON.stringify({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: pod,
        namespace,
        labels: { 'app.kubernetes.io/managed-by': MANAGED_BY, 'pupitre.io/role': 'backup' },
      },
      spec: {
        restartPolicy: 'Never',
        terminationGracePeriodSeconds: 0,
        containers: [
          {
            name: 'helper',
            image: BACKUP_HELPER_IMAGE,
            imagePullPolicy: 'IfNotPresent',
            command: ['sleep', '86400'],
            volumeMounts: [{ name: 'data', mountPath: '/data', readOnly }],
          },
        ],
        volumes: [{ name: 'data', persistentVolumeClaim: { claimName: pvcName(service, volume) } }],
      },
    });
    const step = readOnly ? 'backup.volume' : 'restore.volume';
    try {
      await this.stream(
        ctx,
        this.script([applyManifestCommand(manifest)]),
        () => {},
        step,
        SHORT_TIMEOUT_MS,
      );
      await this.stream(
        ctx,
        this.kubectl(`-n ${namespace} wait --for=condition=Ready pod/${pod} --timeout=180s`),
        () => {},
        step,
        APPLY_TIMEOUT_MS,
      );
      return await run(pod);
    } finally {
      await exec(
        ctx.sshSession,
        this.kubectl(`-n ${namespace} delete pod ${pod} --wait=false --grace-period=0`),
        { timeout: SHORT_TIMEOUT_MS, logOutput: false },
      ).catch(() => undefined);
    }
  }

  async exportVolume(
    ctx: DriverContext,
    service: string,
    volume: string,
    sink: Writable,
  ): Promise<void> {
    await this.withVolumePod(ctx, service, volume, true, (pod) =>
      this.pipeOrFail(
        ctx,
        `kubectl -n ${this.namespace(ctx)} exec ${pod} -- tar czf - -C /data .`,
        'backup.volume',
        { stdout: sink },
      ),
    );
  }

  async importVolume(
    ctx: DriverContext,
    service: string,
    volume: string,
    source: Readable,
  ): Promise<void> {
    await this.withVolumePod(ctx, service, volume, false, (pod) =>
      this.pipeOrFail(
        ctx,
        `kubectl -n ${this.namespace(ctx)} exec -i ${pod} -- sh -c ${shellQuote(CLEAR_AND_EXTRACT)}`,
        'restore.volume',
        { stdin: source },
      ),
    );
  }

  /** In one of the service's pods: `kubectl exec` on the Deployment picks one. */
  async exportFromService(
    ctx: DriverContext,
    service: string,
    command: string,
    sink: Writable,
  ): Promise<void> {
    await this.pipeOrFail(
      ctx,
      `kubectl -n ${this.namespace(ctx)} exec deployment/${service} -- sh -c ${shellQuote(command)}`,
      'backup.dump',
      { stdout: sink },
    );
  }

  async importIntoService(
    ctx: DriverContext,
    service: string,
    command: string,
    source: Readable,
  ): Promise<void> {
    await this.pipeOrFail(
      ctx,
      `kubectl -n ${this.namespace(ctx)} exec -i deployment/${service} -- sh -c ${shellQuote(command)}`,
      'restore.dump',
      { stdin: source },
    );
  }

  /**
   * Pulls the images from the registries before applying the manifests, and
   * keeps the digest obtained for each service.
   *
   * `imagePullPolicy: IfNotPresent` is imposed by the images built on the target
   * (they exist in no registry). Its downside: a tag already present is never
   * pulled again, and `postgres:16` would stay frozen on its first content.
   * Pulling here gives the tag back its current content in containerd — exactly
   * what `docker compose pull` does on the other side.
   *
   * A failure does not stop the deployment: the local image, if it exists, will
   * do, and if it does not, the rollout will say so.
   */
  private async pullImages(ctx: DriverContext, onLog: LogSink): Promise<Map<string, string>> {
    const pulled = new Map<string, string>();
    for (const { service, image, ref } of checkableImages(ctx.spec)) {
      if (ref.digest) continue;
      onLog(`k3s crictl pull ${image}`);
      const result = await exec(
        ctx.sshSession,
        this.script([
          `k3s crictl pull ${shellQuote(image)} >/dev/null && k3s crictl inspecti -o json ${shellQuote(image)}`,
        ]),
        // containerd's socket is only open to root — as for importing the built images,
        // above.
        { timeout: APPLY_TIMEOUT_MS, logOutput: false, sudo: true },
      );
      const digest = result.code === 0 ? pulledDigest(result.stdout, image) : null;
      if (digest) {
        pulled.set(service, digest);
        onLog(`   ${image} → ${digest.slice(0, 19)}…`);
      } else {
        onLog(
          this.say(ctx)('pull.failed', {
            detail: firstLine(result.stderr) ?? `code ${result.code}`,
          }),
        );
      }
    }
    return pulled;
  }

  /**
   * An identical manifest is not a change for Kubernetes: if only the tag's
   * content moved, no pod is replaced. What still runs on the old digest is
   * therefore restarted — and only that.
   */
  private async refreshStaleImages(
    ctx: DriverContext,
    pulled: Map<string, string>,
    onLog: LogSink,
  ): Promise<void> {
    if (pulled.size === 0) return;
    const running = await this.runningImages(ctx);
    for (const { service, digests } of running) {
      const latest = pulled.get(service);
      if (!latest || digests.length === 0 || digests.every((digest) => digest === latest)) continue;
      onLog(this.say(ctx)('pull.stale', { service, digest: latest.slice(0, 19) }));
      await this.stream(
        ctx,
        this.kube(ctx, `rollout restart deployment/${service}`),
        onLog,
        'rollout',
        APPLY_TIMEOUT_MS,
      );
      await this.stream(
        ctx,
        this.kube(ctx, `rollout status deployment/${service} --timeout=${ROLLOUT_TIMEOUT}`),
        onLog,
        'rollout',
        APPLY_TIMEOUT_MS,
      );
    }
  }

  /**
   * A workload's life cycle, in Kubernetes:
   *
   *   - **restart**: `rollout restart` of the controller, then `rollout status` —
   *     the pods are replaced on the current manifest;
   *   - **stop**: replicas of a Deployment or a StatefulSet set to zero. The
   *     previous count is noted in an annotation, so that "start" restores it as
   *     is;
   *   - **start**: the noted replicas (one, otherwise), then `rollout status`.
   *
   * A DaemonSet runs on every node by construction: it does not stop without
   * being deleted. A pod without a controller is not recreated. Both are refused
   * rather than disguised.
   */
  async controlWorkload(
    ctx: TargetContext,
    ref: WorkloadRef,
    action: WorkloadControlAction,
    onLog: LogSink,
  ): Promise<void> {
    const say = this.say(ctx);
    const step = `workload.${action}`;
    const { workload, resource } = await this.findWorkload(ctx, ref, step);
    if (workload.managed && action !== 'restart') {
      throw new DriverError(
        managedWorkloadControlRefusal(workload, ctx.language),
        this.runtime,
        step,
      );
    }
    if (SYSTEM_NAMESPACES.has(resource.namespace)) {
      throw new DriverError(
        say('workload.system.control', { name: workload.name, namespace: resource.namespace }),
        this.runtime,
        step,
      );
    }
    const ns = `-n ${resource.namespace}`;
    const path = `${resource.kind}/${resource.name}`;

    if (action === 'restart') {
      if (resource.kind === 'pod') {
        throw new DriverError(
          say('workload.control.podRestart', { name: workload.name }),
          this.runtime,
          step,
        );
      }
      onLog(`→ kubectl ${ns} rollout restart ${path}`);
      await this.stream(
        ctx,
        this.kubectl(`${ns} rollout restart ${path}`),
        onLog,
        step,
        APPLY_TIMEOUT_MS,
      );
      await this.stream(
        ctx,
        this.kubectl(`${ns} rollout status ${path} --timeout=${ROLLOUT_TIMEOUT}`),
        onLog,
        step,
        APPLY_TIMEOUT_MS,
      );
      onLog(say('workload.control.replaced'));
      return;
    }

    if (resource.kind !== 'deployment' && resource.kind !== 'statefulset') {
      throw new DriverError(
        resource.kind === 'daemonset'
          ? say('workload.control.daemonset', { name: workload.name })
          : say('workload.control.podStop', { name: workload.name }),
        this.runtime,
        step,
      );
    }

    const read = await exec(
      ctx.sshSession,
      this.kubectl(
        `${ns} get ${path} -o jsonpath='{.spec.replicas}{" "}{.metadata.annotations.pupitre\\.io/replicas-before-stop}'`,
      ),
      { timeout: SHORT_TIMEOUT_MS, logOutput: false },
    );
    const [currentRaw = '', savedRaw = ''] = read.stdout.trim().split(/\s+/);
    const current = Number.parseInt(currentRaw, 10) || 0;

    if (action === 'stop') {
      if (current === 0) {
        onLog(say('workload.control.alreadyStopped'));
        return;
      }
      onLog(say('workload.control.scalingDown', { ns, path, count: current }));
      await this.stream(
        ctx,
        this.kubectl(
          `${ns} annotate ${path} pupitre.io/replicas-before-stop=${current} --overwrite`,
        ),
        onLog,
        step,
        SHORT_TIMEOUT_MS,
      );
      await this.stream(
        ctx,
        this.kubectl(`${ns} scale ${path} --replicas=0`),
        onLog,
        step,
        SHORT_TIMEOUT_MS,
      );
      onLog(say('workload.control.stopped'));
      return;
    }

    if (current > 0) {
      onLog(say('workload.control.alreadyRunning', { count: current }));
      return;
    }
    const replicas = Math.max(1, Number.parseInt(savedRaw, 10) || 1);
    onLog(`→ kubectl ${ns} scale ${path} --replicas=${replicas}`);
    await this.stream(
      ctx,
      this.kubectl(`${ns} scale ${path} --replicas=${replicas}`),
      onLog,
      step,
      SHORT_TIMEOUT_MS,
    );
    await this.stream(
      ctx,
      this.kubectl(`${ns} annotate ${path} pupitre.io/replicas-before-stop-`),
      onLog,
      step,
      SHORT_TIMEOUT_MS,
      false,
    );
    await this.stream(
      ctx,
      this.kubectl(`${ns} rollout status ${path} --timeout=${ROLLOUT_TIMEOUT}`),
      onLog,
      step,
      APPLY_TIMEOUT_MS,
    );
    onLog(say('workload.control.started'));
  }

  /**
   * A workload's log, **all its pods**: `kubectl logs deployment/x` would only
   * read one ("Found 2 pods, using pod/…"). For a controller, we therefore go
   * through its selector, then put the lines back in time order — each pod
   * arrives in one block, and the operator reads a chronology.
   */
  async workloadLogs(
    ctx: TargetContext,
    ref: WorkloadRef,
    tail: number,
    onLine: LogSink,
  ): Promise<void> {
    const { resource } = await this.findWorkload(ctx, ref, 'workload.logs');
    const lines = Math.max(1, Math.floor(tail));
    const ns = `-n ${resource.namespace}`;

    let source = `${resource.kind}/${resource.name}`;
    if (resource.kind !== 'pod') {
      const read = await exec(
        ctx.sshSession,
        this.kubectl(`${ns} get ${source} -o jsonpath='{.spec.selector.matchLabels}'`),
        { timeout: SHORT_TIMEOUT_MS, logOutput: false },
      );
      const selector = labelSelector(read.stdout);
      if (!selector) {
        throw new DriverError(
          this.say(ctx)('workload.logs.noSelector', { name: resource.name }),
          this.runtime,
          'workload.logs',
        );
      }
      source = `-l ${shellQuote(selector)} --max-log-requests=20`;
    }

    const collected: string[] = [];
    await this.stream(
      ctx,
      this.kubectl(
        `${ns} logs ${source} --all-containers=true --prefix --timestamps --tail=${lines}`,
      ),
      (line) => collected.push(line),
      'workload.logs',
      SHORT_TIMEOUT_MS,
    );
    for (const line of chronological(collected).slice(-lines)) onLine(line);
  }

  /**
   * `kubectl exec` on the resource: for a controller, kubectl picks one of its
   * pods. Not in the system namespaces, no more than we delete there.
   */
  async execInWorkload(
    ctx: TargetContext,
    ref: WorkloadRef,
    command: string,
    onLine: LogSink,
    options: WorkloadExecOptions,
  ): Promise<WorkloadExecResult> {
    const { workload, resource } = await this.findWorkload(ctx, ref, 'workload.exec');
    if (SYSTEM_NAMESPACES.has(resource.namespace)) {
      throw new DriverError(
        this.say(ctx)('workload.system.exec', {
          name: workload.name,
          namespace: resource.namespace,
        }),
        this.runtime,
        'workload.exec',
      );
    }
    if (!workload.exec) {
      throw new DriverError(
        this.say(ctx)('workload.exec.noReadyPod', { name: workload.name }),
        this.runtime,
        'workload.exec',
      );
    }
    return runBoundedExec(
      ctx.sshSession,
      this.kubectl(
        `-n ${resource.namespace} exec ${resource.kind}/${resource.name} -- sh -c ${quoteForShell(command)} 2>&1`,
      ),
      onLine,
      options,
    );
  }

  /** Reads a workload again on the cluster, and refuses to act blindly. */
  private async findWorkload(
    ctx: TargetContext,
    ref: WorkloadRef,
    step: string,
  ): Promise<{ workload: Workload; resource: K3sResourceRef }> {
    const say = this.say(ctx);
    const resource = parseResourceRef(ref.id);
    if (!resource) {
      throw new DriverError(say('workload.badRef', { id: ref.id }), this.runtime, step);
    }

    const result = await exec(
      ctx.sshSession,
      this.kubectl(`-n ${resource.namespace} get ${resource.kind} ${resource.name} -o json`),
      { timeout: SHORT_TIMEOUT_MS, logOutput: false },
    );

    if (result.code !== 0) {
      throw new DriverError(
        say('workload.notFound', {
          id: ref.id,
          detail: firstLine(result.stderr) ?? `code ${result.code}`,
        }),
        this.runtime,
        step,
      );
    }

    const workload = parseSingleWorkload(result.stdout, resource, ctx.language);
    if (!workload) {
      throw new DriverError(say('workload.unreadable', { id: ref.id }), this.runtime, step);
    }

    return { workload, resource };
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
        this.say(ctx)('command.failed', { command, detail }),
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
    sudo = false,
  ): Promise<void> {
    const result = await execStream(ctx.sshSession, command, (line) => onLog(line), {
      timeout,
      logOutput: false,
      sudo,
    });

    const say = this.say(ctx);
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

// ─── utilitaires ──────────────────────────────────────────────────────────────

/**
 * These few functions also exist in the Docker driver. It is deliberate: a
 * driver does not depend on another driver. The day one changes shell or output
 * format, the other knows nothing about it.
 */

/** POSIX escaping in single quotes. */
/** What it takes to run `tar`, nothing else — the image of backup operations. */
const BACKUP_HELPER_IMAGE = 'busybox:1.37';

/** Empties the volume — hidden files included —, then extracts the archive read on stdin. */
const CLEAR_AND_EXTRACT = 'cd /data && rm -rf -- * .[!.]* ..?* 2>/dev/null; tar xzf - -C /data';

/** Last non-empty line: the probe prints its code after kubectl's noise. */
function lastNonEmptyLine(value: string): string | null {
  const lines = value.split('\n').filter((line) => line.trim().length > 0);
  return lines[lines.length - 1]?.trim() ?? null;
}

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

type KubeCondition = { type?: string; status?: string };

type NodeItem = {
  status?: {
    conditions?: KubeCondition[];
    nodeInfo?: { kubeletVersion?: string };
  };
};

/** `kubectl get nodes -o json`: number of nodes, ready nodes, version. */
function parseNodes(
  output: string,
): { nodes: number; readyNodes: number; version: string | null } | null {
  let parsed: { items?: NodeItem[] };
  try {
    parsed = JSON.parse(output) as { items?: NodeItem[] };
  } catch {
    return null;
  }

  const items = parsed.items;
  if (!Array.isArray(items)) return null;

  const readyNodes = items.filter((item) =>
    item.status?.conditions?.some(
      (condition) => condition.type === 'Ready' && condition.status === 'True',
    ),
  ).length;

  return {
    nodes: items.length,
    readyNodes,
    version: items[0]?.status?.nodeInfo?.kubeletVersion ?? null,
  };
}

type PodItem = {
  metadata?: { name?: string; deletionTimestamp?: string };
  status?: { conditions?: KubeCondition[]; phase?: string };
};

/** `kubectl get pods -o json`: how many are ready, and which are not. */
export function parsePodReadiness(
  output: string,
): { total: number; ready: number; pending: string[] } | null {
  let parsed: { items?: PodItem[] };
  try {
    parsed = JSON.parse(output) as { items?: PodItem[] };
  } catch {
    return null;
  }

  const items = parsed.items;
  if (!Array.isArray(items)) return null;

  const pending: string[] = [];
  let ready = 0;

  let total = 0;
  for (const item of items) {
    // A pod being deleted belongs to the past: an old ReplicaSet going away, an
    // eviction wreck. It says nothing about the version just set, and must not make
    // it roll back.
    if (item.metadata?.deletionTimestamp) continue;
    total += 1;
    const isReady =
      item.status?.conditions?.some(
        (condition) => condition.type === 'Ready' && condition.status === 'True',
      ) ?? false;
    // A pod that completed successfully does not have to be "Ready": it finished its work.
    if (isReady || item.status?.phase === 'Succeeded') {
      ready += 1;
    } else {
      pending.push(item.metadata?.name ?? '?');
    }
  }

  return { total, ready, pending };
}


type PodJson = {
  items?: Array<{
    metadata?: { name?: string; labels?: Record<string, string> };
    status?: {
      phase?: string;
      startTime?: string;
      containerStatuses?: Array<{ ready?: boolean; image?: string; restartCount?: number }>;
    };
  }>;
};

/** Phase Kubernetes → vocabulaire neutre. */
function toServiceState(phase: string, ready: boolean): ServiceState {
  switch (phase) {
    case 'Running':
      return ready ? 'running' : 'restarting';
    case 'Pending':
      return 'created';
    case 'Succeeded':
    case 'Failed':
      return 'exited';
    default:
      return 'unknown';
  }
}

function parsePods(json: string, language: UiLanguage = 'fr'): ServiceStatus[] {
  const say = k3sSay(language);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }

  const payload = parsed as PodJson;
  if (!Array.isArray(payload.items)) return [];

  return payload.items.map((pod) => {
    const containers = pod.status?.containerStatuses ?? [];
    const ready = containers.length > 0 && containers.every((c) => c.ready === true);
    const phase = pod.status?.phase ?? 'Unknown';
    const restarts = containers.reduce((sum, c) => sum + (c.restartCount ?? 0), 0);

    return {
      name:
        pod.metadata?.labels?.['app.kubernetes.io/name'] ??
        pod.metadata?.name ??
        say('name.unknown'),
      state: toServiceState(phase, ready),
      health: ready ? ('healthy' as const) : phase === 'Running' ? ('starting' as const) : ('none' as const),
      since: pod.status?.startTime
        ? `${phase}${restarts > 0 ? say('since.restarts', { count: restarts }) : ''}`
        : phase,
      image: containers[0]?.image ?? null,
      ports: [],
    };
  });
}

// ─── the target's workloads: reading Kubernetes ───────────────────────────────

/**
 * Namespaces that run the cluster. Nothing in them carries the panel's label,
 * and yet deleting anything there would break the machine: the guard is here,
 * in the driver, because it is a particularity of this runtime.
 */
const SYSTEM_NAMESPACES = new Set(['kube-system', 'kube-public', 'kube-node-lease']);

/** Kinds of drivable workloads, in `kubectl`'s vocabulary. */
const CONTROLLER_KINDS: Record<string, string> = {
  Deployment: 'deployment',
  StatefulSet: 'statefulset',
  DaemonSet: 'daemonset',
};

export type K3sResourceRef = { namespace: string; kind: string; name: string };

/**
 * Handle of a K3s workload: `namespace:kind:name`.
 *
 * The `:` fits: it is allowed in a URL segment and forbidden in a DNS-1123
 * name, hence in a Kubernetes resource name. No possible ambiguity when
 * splitting.
 */
function encodeResourceRef(resource: K3sResourceRef): string {
  return `${resource.namespace}:${resource.kind}:${resource.name}`;
}

function parseResourceRef(raw: string): K3sResourceRef | null {
  const parts = raw.split(':');
  if (parts.length !== 3) return null;

  const [namespace, kind, name] = parts;
  if (!namespace || !kind || !name) return null;
  if (kind !== 'pod' && !Object.values(CONTROLLER_KINDS).includes(kind)) return null;

  return { namespace, kind, name };
}

type KubeMeta = {
  name?: string;
  namespace?: string;
  labels?: Record<string, string> | null;
  creationTimestamp?: string;
  ownerReferences?: Array<{ kind?: string; name?: string }> | null;
};

type KubeContainerSpec = { image?: string; ports?: Array<{ hostPort?: number; containerPort?: number; protocol?: string }> | null };

type KubeItem = {
  kind?: string;
  metadata?: KubeMeta;
  spec?: {
    replicas?: number;
    template?: { spec?: { containers?: KubeContainerSpec[] | null } | null } | null;
    containers?: KubeContainerSpec[] | null;
  } | null;
  status?: {
    replicas?: number;
    readyReplicas?: number;
    availableReplicas?: number;
    desiredNumberScheduled?: number;
    numberReady?: number;
    phase?: string;
    startTime?: string;
    conditions?: KubeCondition[] | null;
    containerStatuses?: Array<{
      name?: string;
      ready?: boolean;
      image?: string;
      imageID?: string;
      restartCount?: number;
    }> | null;
  } | null;
};

function kubeItems(json: string): KubeItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }

  const payload = parsed as { items?: KubeItem[] };
  return Array.isArray(payload.items) ? payload.items : [];
}

/** Ports published on the **node**. In Kubernetes it is rare: normal exposure
 * goes through a Service and an Ingress, which do not belong to the workload.
 * We therefore only report the `hostPort`s actually declared, rather than
 * making up a mapping that does not exist. */
function hostPorts(containers: KubeContainerSpec[] | null | undefined): string[] {
  const out: string[] = [];
  for (const container of containers ?? []) {
    for (const port of container.ports ?? []) {
      if (!port.hostPort) continue;
      const entry = `${port.hostPort}→${port.containerPort ?? port.hostPort}/${(port.protocol ?? 'TCP').toLowerCase()}`;
      if (!out.includes(entry)) out.push(entry);
    }
  }
  return out;
}

function isManaged(meta: KubeMeta | undefined): boolean {
  // Both generations, for the same reason as the selectors: a resource set up
  // before the renaming still belongs to the panel.
  const managedBy = (meta?.labels ?? {})['app.kubernetes.io/managed-by'];
  return managedBy === MANAGED_BY || managedBy === LEGACY_MANAGED_BY;
}

function managedApp(meta: KubeMeta | undefined): string | null {
  const labels = meta?.labels ?? {};
  return labels['app.kubernetes.io/part-of'] ?? labels['app.kubernetes.io/instance'] ?? null;
}

/** A controller is "running" when all its expected replicas are. */
function controllerState(item: KubeItem, say: K3sSay): { state: ServiceState; since: string } {
  const status = item.status ?? {};
  const desired =
    item.kind === 'DaemonSet'
      ? (status.desiredNumberScheduled ?? 0)
      : (item.spec?.replicas ?? status.replicas ?? 0);
  const ready = item.kind === 'DaemonSet' ? (status.numberReady ?? 0) : (status.readyReplicas ?? 0);

  const since = say('since.ready', { ready, count: desired });

  // Zero replicas wanted is not an outage: it is a workload deliberately stopped,
  // the equivalent of an `exited` container.
  if (desired === 0) return { state: 'exited', since: say('since.scaledToZero') };
  if (ready >= desired) return { state: 'running', since };
  if (ready === 0) return { state: 'created', since };
  return { state: 'restarting', since };
}

function toControllerWorkload(item: KubeItem, kind: string, say: K3sSay): Workload | null {
  const meta = item.metadata;
  if (!meta?.name || !meta.namespace) return null;

  const containers = item.spec?.template?.spec?.containers ?? null;
  const { state, since } = controllerState(item, say);
  const ready = state === 'running';
  const managed = isManaged(meta);
  const system = SYSTEM_NAMESPACES.has(meta.namespace);

  return {
    runtime: 'k3s',
    id: encodeResourceRef({ namespace: meta.namespace, kind, name: meta.name }),
    name: meta.name,
    kind,
    scope: meta.namespace,
    image: containers?.[0]?.image ?? null,
    state,
    health: ready ? 'healthy' : state === 'exited' ? 'none' : 'starting',
    createdAt: meta.creationTimestamp ?? null,
    since,
    ports: hostPorts(containers),
    managed,
    managedApp: managedApp(meta),
    controls: system ? [] : controllerControls(kind, state, managed),
    exec: !system && ready,
  };
}

/**
 * What a controller accepts: all of them restart; only a Deployment and a
 * StatefulSet stop (zero replicas) and start again — a DaemonSet runs on every
 * node by construction. A panel workload can only restart.
 */
function controllerControls(
  kind: string,
  state: ServiceState,
  managed: boolean,
): WorkloadControlAction[] {
  // Stopped, a panel workload waits for its application to start again: a
  // `rollout restart` with zero replicas would do nothing.
  if (managed) return state === 'exited' ? [] : ['restart'];
  if (kind === 'daemonset') return ['restart'];
  return state === 'exited' ? ['start'] : ['stop', 'restart'];
}

function toPodWorkload(item: KubeItem, say: K3sSay): Workload | null {
  const meta = item.metadata;
  if (!meta?.name || !meta.namespace) return null;

  const statuses = item.status?.containerStatuses ?? [];
  const ready = statuses.length > 0 && statuses.every((container) => container.ready === true);
  const phase = item.status?.phase ?? 'Unknown';
  const restarts = statuses.reduce((sum, container) => sum + (container.restartCount ?? 0), 0);

  return {
    runtime: 'k3s',
    id: encodeResourceRef({ namespace: meta.namespace, kind: 'pod', name: meta.name }),
    name: meta.name,
    kind: 'pod',
    scope: meta.namespace,
    image: statuses[0]?.image ?? item.spec?.containers?.[0]?.image ?? null,
    state: toServiceState(phase, ready),
    health: ready ? 'healthy' : phase === 'Running' ? 'starting' : 'none',
    createdAt: meta.creationTimestamp ?? null,
    since: `${phase}${restarts > 0 ? say('since.restarts', { count: restarts }) : ''}`,
    ports: hostPorts(item.spec?.containers ?? null),
    managed: isManaged(meta),
    managedApp: managedApp(meta),
    // A pod without a controller can neither restart nor stop: nothing would
    // recreate it. Its log can still be read and a command run in it.
    controls: [],
    exec: !SYSTEM_NAMESPACES.has(meta.namespace) && ready,
  };
}

/**
 * `kubectl get deployments,statefulsets,daemonsets,pods -A -o json` → workloads.
 * Pods driven by a controller are left out: their row would be a decoy.
 */
export function parseWorkloads(json: string, language: UiLanguage = 'fr'): Workload[] {
  const say = k3sSay(language);
  const workloads: Workload[] = [];

  for (const item of kubeItems(json)) {
    const controllerKind = CONTROLLER_KINDS[item.kind ?? ''];
    if (controllerKind) {
      const workload = toControllerWorkload(item, controllerKind, say);
      if (workload) workloads.push(workload);
      continue;
    }

    if (item.kind !== 'Pod') continue;
    if ((item.metadata?.ownerReferences ?? []).length > 0) continue;

    const workload = toPodWorkload(item, say);
    if (workload) workloads.push(workload);
  }

  return workloads;
}

/** `kubectl get <kind> <name> -o json` → a workload, or nothing. */
function parseSingleWorkload(
  json: string,
  resource: K3sResourceRef,
  language: UiLanguage,
): Workload | null {
  const say = k3sSay(language);
  let item: KubeItem;
  try {
    item = JSON.parse(json) as KubeItem;
  } catch {
    return null;
  }

  return resource.kind === 'pod'
    ? toPodWorkload(item, say)
    : toControllerWorkload(item, resource.kind, say);
}

/**
 * `{"app":"web","tier":"front"}` → `app=web,tier=front`. Nothing readable →
 * `null`: better to refuse than to read the log of the whole namespace.
 */
export function labelSelector(matchLabels: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(matchLabels.trim() || 'null');
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const pairs = Object.entries(parsed as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  if (pairs.length === 0) return null;
  return pairs.map(([key, value]) => `${key}=${value}`).join(',');
}

const STAMP = /^(?:\[[^\]]*\] )?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z /;

/**
 * Puts lines `[pod/x/c] 2026-…Z text` back in time order.
 *
 * Timestamps are in UTC, in RFC 3339 "nano" format — which **strips** trailing
 * zeros: `33.1Z` and `33.123456789Z` do not compare as strings. The fraction is
 * therefore padded to nine digits. Stable sort: a line without a timestamp (a
 * continuation) stays behind the one before it.
 */
export function chronological(lines: string[]): string[] {
  let last = '';
  return lines
    .map((line, index) => {
      const match = STAMP.exec(line);
      if (match) last = `${match[1]}.${(match[2] ?? '').padEnd(9, '0').slice(0, 9)}`;
      return { line, index, key: last };
    })
    .sort((a, b) => (a.key === b.key ? a.index - b.index : a.key < b.key ? -1 : 1))
    .map((entry) => entry.line);
}

/**
 * The digests of an application's pods, per service. The service is the
 * `app.kubernetes.io/name` label set by the render; `imageID` is containerd's
 * `docker.io/library/nginx@sha256:…` form.
 */
export function parsePodImages(json: string): RunningImage[] {
  const byService = new Map<string, Set<string>>();
  for (const item of kubeItems(json)) {
    const service = item.metadata?.labels?.['app.kubernetes.io/name'];
    if (!service) continue;
    const digests = byService.get(service) ?? new Set<string>();
    for (const container of item.status?.containerStatuses ?? []) {
      if (container.name && container.name !== service) continue;
      const digest = container.imageID ? digestOf(container.imageID) : null;
      if (digest) digests.add(digest);
    }
    byService.set(service, digests);
  }
  return [...byService].map(([service, digests]) => ({ service, digests: [...digests] }));
}

/**
 * The digest of a pulled image, read from `crictl inspecti -o json`: among its
 * `repoDigests`, the one of the requested repository (the same image can be
 * known under several names).
 */
export function pulledDigest(json: string, image: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const repoDigests = (parsed as { status?: { repoDigests?: unknown } }).status?.repoDigests;
  if (!Array.isArray(repoDigests)) return null;
  const ref = parseImageReference(image);
  const wanted = ref
    ? `${ref.registry === 'registry-1.docker.io' ? 'docker.io' : ref.registry}/${ref.repository}@`
    : null;
  const candidates = repoDigests.filter((value): value is string => typeof value === 'string');
  const match = (wanted && candidates.find((value) => value.startsWith(wanted))) ?? candidates[0];
  return match ? digestOf(match) : null;
}
