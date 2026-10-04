import type { UiLanguage } from '../i18n.js';
import type { PortAllocator } from '../ports.js';
import type { AppStatus } from '../supervision.js';
import type { AppSpec } from '../spec/index.js';
import type { SshSession } from '../ssh/client.js';
import type { Workload, WorkloadControlAction, WorkloadRef } from '../workloads.js';
import type { WorkloadExecOptions, WorkloadExecResult } from './workload-exec.js';
import type { RunningImage } from '../images/updates.js';
import type { ProxyUpstream } from '../proxy/model.js';
import type { ImageStore } from '../scan.js';
import type { Readable, Writable } from 'node:stream';

/**
 * The contract a runtime must fulfill to be deployable by the panel.
 *
 * The structuring rule: the driver **imports nothing** from `packages/db`, nor
 * from `apps/web`, nor from Redis. It receives everything through its context,
 * it executes, and it emits lines. It is the caller that decides what to do with
 * them — publish them on Redis, write them to the database, or drop them.
 *
 * Adding a runtime must be done by adding a class here, without changing a
 * single line elsewhere.
 */

export type RuntimeKind = 'docker' | 'k3s';

/** Remote machine, as the driver needs to know it. */
export type DriverTarget = {
  id: string;
  name: string;
  host: string;
  /** Root path where the driver places its artifacts on the target. */
  rootPath: string;
};

/** Deployment in progress, as the driver needs to know it. */
export type DriverDeployment = {
  id: string;
  /** Deployed application version, taken from the AppSpec. */
  version: string;
  /** Incremental number, used to name the directories on the target. */
  sequence: number;
};

export type { PortAllocator } from '../ports.js';

/** Values of the secrets the AppSpec declares, resolved by the caller. */
export type SecretResolver = (names: readonly string[]) => Promise<Record<string, string>>;

/** Rendered file, ready to be placed on the target. */
export type RenderedFile = {
  /** Path relative to the bundle's root. */
  path: string;
  content: string;
  /** Mode POSIX, ex. `0o644`. */
  mode?: number;
};

/** What the expiry of an image builder did (`pruneIdleBuilder`). */
export type BuilderPruneResult = {
  /**
   * `absent`: nothing to expire. `kept`: used recently, or claimed by a build
   * just now. `removed`: removed.
   */
  outcome: 'absent' | 'kept' | 'removed';
  /** Its last build (ISO), when there was one. */
  lastUsedAt: string | null;
};

/**
 * Context at the level of the **machine**, not of a deployment.
 *
 * It exists because `listWorkloads`, `removeWorkload` and `updateWorkload` have
 * no AppSpec, slug or version number to offer: they look at the whole target,
 * including what the panel never deployed. The other way — making `spec`,
 * `deployment`, `appSlug` and `applicationId` optional in `DriverContext` —
 * would have produced a type with half its fields `undefined` half the time:
 * the compiler would have stopped guaranteeing that a `deploy()` does receive a
 * spec, and each driver would have had to reopen the question by hand. A type
 * that lies about what it contains no longer protects anyone.
 *
 * `DriverContext` is an extension of it: everything that accepts a deployment
 * context already accepts a target context, and no existing call changes.
 */
export type TargetContext = {
  target: DriverTarget;
  sshSession: SshSession;
  /**
   * The instance's language: that of what the driver says — deployment log lines,
   * preflight results, errors. Required, so that no caller forgets it: the worker
   * reads it from the settings at the start of each task, as for commit statuses
   * and notifications.
   */
  language: UiLanguage;
};

export type DriverContext = TargetContext & {
  spec: AppSpec;
  deployment: DriverDeployment;
  /** Identifiant stable de l'application. Sert de namespace : `app-{slug}`. */
  appSlug: string;
  /** The application's database identifier, for port reservations. */
  applicationId: string;
  /** Deployment that `rollback()` goes back to. */
  previousDeployment?: DriverDeployment;
  portAllocator?: PortAllocator;
  /**
   * Range of publishable ports on this target. Default: 30000-32767. A target
   * behind a firewall often has only part of it open.
   */
  portRange?: { min: number; max: number };
  resolveSecrets?: SecretResolver;
  /**
   * How a reverse proxy reaches the application, when its domains go through it —
   * which decides how its port is published. Absent: no proxy, the runtime's usual
   * publication. It is the pipeline that decides, given the routes; the driver
   * applies what makes sense on its side.
   */
  exposure?: DriverExposure;
  /**
   * Extra files to place with the rendered artifacts — typically the source code,
   * when a service is built from a Dockerfile. The driver does not know where
   * they come from: neither git, nor registry, nor archive. It is the pipeline
   * that provides them.
   */
  additionalFiles?: RenderedFile[];
  /**
   * The source code when it comes from a linked repository: a `tar.gz` archive on
   * the worker's disk, which the driver places and unpacks into the release's
   * `source/` (`SOURCE_DIR`), apart from its own files. The same principle as
   * `additionalFiles`: the driver does not know where it comes from.
   */
  sourceArchive?: SourceArchive;
  /**
   * This deployment brings a repository's code: the AppSpec's build contexts,
   * relative to the repository's root, resolve under `source/`. Known from the
   * render on, before the archive is downloaded.
   */
  sourceInRelease?: boolean;
};

export type DriverExposure = {
  /**
   * Where to publish the port: `127.0.0.1` for a proxy on the same machine, the
   * private address through which a remote proxy reaches this one. Absent: every
   * interface. The port must not be reachable from elsewhere — otherwise it would
   * bypass the proxy's HTTPS.
   */
  bindAddress?: string;
  /** Only open the firewall to this address: the remote proxy's. */
  allowFrom?: string;
  /**
   * The proxy reaches the application through a port of the machine: a runtime
   * that does not usually publish one must publish one — a NodePort, on K3s.
   */
  byPort?: boolean;
};

export type SourceArchive = {
  /** Local path of the archive, on the worker side. */
  localPath: string;
  /** Leading folders to strip on extraction: 1 for a GitHub archive. */
  stripComponents: number;
};

export type PreflightResult = {
  ok: boolean;
  /** Version of the execution engine on the target. */
  runtimeVersion: string | null;
  /** Space available on the driver's root mount point, in MiB. */
  availableDiskMi: number | null;
  checks: Array<{
    key: string;
    label: string;
    ok: boolean;
    detail: string | null;
  }>;
};

export type RenderedArtifacts = {
  /** Nom du projet / namespace : `app-{slug}`. */
  projectName: string;
  files: RenderedFile[];
  /** Port published on the target, or `null` if exposure goes through an Ingress. */
  publishedPort: number | null;
};

export type DeployResult = {
  ok: boolean;
  /** URL through which the application answers, if the driver can determine it. */
  url: string | null;
  publishedPort: number | null;
  /** Directory of the version deployed on the target. */
  releasePath: string;
  /** Images built or pulled, for the history and the scanners. */
  images: string[];
};

/**
 * Outcome of a health probe. Three cases, not two:
 *   healthy      the service answers, and answers well;
 *   unhealthy    it answers, but with a code outside 2xx/3xx — it runs, it is broken;
 *   unreachable  nothing at the other end: container missing, port closed, pod not ready.
 *
 * The distinction changes the diagnosis to produce, and it is lost as soon as it
 * is reduced to a boolean.
 */
export type HealthOutcome = 'healthy' | 'unhealthy' | 'unreachable';

export type HealthResult = {
  healthy: boolean;
  outcome: HealthOutcome;
  attempts: number;
  /** Last HTTP code observed, if the probe is HTTP. */
  statusCode: number | null;
  detail: string | null;
  /**
   * Diagnosis captured **on the target** at the time of the failure: state of the
   * containers or pods, and their last logs. Captured before returning, because a
   * rollback that follows would wipe the scene.
   */
  diagnostics: string | null;
};

/** The driver emits lines, it does not know where they go. */
export type LogSink = (line: string) => void;

export interface DeploymentDriver {
  readonly runtime: RuntimeKind;

  /**
   * Name under which this runtime groups the application on the machine: Compose
   * project on Docker, namespace on K3s. Convention `app-{slug}`.
   *
   * The only method of the interface that requires **neither context nor SSH
   * session**: that is exactly what is needed when the target is unreachable and
   * we must still write, in the activity log, what will remain to clean up by
   * hand. On the interface rather than with the caller, because this name is a
   * driver decision — deriving it elsewhere would leak a runtime's vocabulary out
   * of its class.
   */
  workspaceName(appSlug: string): string;

  /**
   * The commands to run **on the machine** to tear this application down by hand,
   * when the panel no longer has the means to do it itself — unreachable target,
   * record deleted by force.
   *
   * On the interface for the same reason as `workspaceName()`:
   * `docker compose down` and `kubectl delete namespace` are runtime vocabulary,
   * and the rule is that it does not leave a driver class. The day destruction
   * learns one more gesture, it is added here too, in the same place. Pure,
   * without a session: it is precisely when a session is impossible that it is
   * needed.
   */
  manualCleanup(appSlug: string, rootPath: string): string[];

  /** Is the target able to host this deployment? */
  preflight(ctx: DriverContext): Promise<PreflightResult>;

  /**
   * Reserves the public port. Returns `null` when the runtime does not expose
   * through a port — the K3sDriver goes through an Ingress.
   *
   * `onLog` is optional: the reservation is silent normally, but it has things to
   * say when a reserved port turns out to be taken on the target by a service
   * foreign to the panel.
   */
  allocatePort(ctx: DriverContext, onLog?: LogSink): Promise<number | null>;

  /**
   * How a reverse proxy reaches the application's exposed service: the port
   * published on the machine, or the cluster's Service. `null`: nothing to reach
   * — no published port. Pure: it is a runtime decision, which requires no read
   * of the target.
   *
   * On the interface, and not with the caller: the pipeline routes to what the
   * driver announces, without knowing which runtime it drives. The proxy says
   * which of the two it can reach.
   */
  upstream(ctx: DriverContext, publishedPort: number | null): ProxyUpstream | null;

  /** Traduit l'AppSpec en artefacts propres au runtime. Aucun effet de bord. */
  render(ctx: DriverContext): Promise<RenderedArtifacts>;

  /**
   * Places the artifacts on the target and checks that everything is in place.
   * Separate from `deploy()` because the pipeline makes it an observable step.
   */
  upload(ctx: DriverContext, artifacts: RenderedArtifacts, onLog: LogSink): Promise<void>;

  /**
   * Builds the images to build. Returns `null` when there is nothing to build —
   * the corresponding step will be marked `skipped`. It is the driver that
   * decides, not the caller.
   */
  build(ctx: DriverContext, onLog: LogSink): Promise<string[] | null>;

  /**
   * Images this deployment will run, as **this runtime** names them.
   *
   * Naming a built image is a driver decision (project prefix on Compose,
   * namespace prefix on K3s): the caller has no way to guess it. The scanners
   * need this list before `deploy()`, while no container has started yet.
   */
  images(ctx: DriverContext): Promise<string[]>;

  /**
   * Where these images are on the target, so the scanners can read them. A built
   * image exists in no registry: a scanner looking for it in the wrong place would
   * return a failure, or nothing.
   */
  imageStore(ctx: DriverContext): ImageStore;

  /**
   * Starts the services. Assumes `upload()` and, if needed, `build()` are done.
   *
   * If the new version took the old one's place without becoming healthy, the
   * failure is an `UnhealthyReleaseError`: the pipeline treats it as a failed
   * healthcheck, automatic rollback included.
   */
  deploy(ctx: DriverContext, onLog: LogSink): Promise<DeployResult>;

  healthcheck(ctx: DriverContext): Promise<HealthResult>;

  /** Redeploys the previous version. Requires `ctx.previousDeployment`. */
  rollback(ctx: DriverContext, onLog: LogSink): Promise<void>;

  /** Destroys the deployment and releases its resources. */
  destroy(ctx: DriverContext, onLog: LogSink): Promise<void>;

  /**
   * Deletes the version directories beyond the `keep` most recent ones, always
   * preserving the current version. Returns what was deleted.
   *
   * On the interface, and not with the caller: it is the driver that knows where
   * it places its releases. The `cleanup:versions` scheduled task calls it without
   * ever naming a path, nor knowing which runtime it runs on.
   */
  pruneReleases(ctx: DriverContext, onLog: LogSink, keep?: number): Promise<string[]>;

  /** Follows the application logs, line by line, until interrupted. */
  logs(ctx: DriverContext, onLine: LogSink): Promise<void>;

  /**
   * Current state of the services, as the runtime reports it. Read-only and
   * quick: it serves monitoring, not the pipeline.
   */
  status(ctx: DriverContext): Promise<AppStatus>;

  /**
   * Restarts the application without redeploying it: same images, same volumes,
   * same port. It is not a rollback, it is not a deployment.
   */
  restart(ctx: DriverContext, onLog: LogSink): Promise<void>;

  /**
   * Stops the application without tearing anything down.
   *
   * ── The contract, identical on both runtimes ───────────────────────────────
   * What stops: the processes, and only them.
   * What stays: the volumes and their data, the port reservation in the database,
   * the release directory on the target, the proxy entry or the Ingress, and the
   * deployment record. `start()` must be able to put back in service **exactly**
   * what `deploy()` had set up — without a new render, without a rebuild, without
   * a version change.
   *
   * Idempotent: stopping an application already stopped succeeds doing nothing.
   * That is what makes the gesture replayable after a session cut, and what avoids
   * having to query the state before acting.
   *
   * ── One observable divergence, and it is accepted ──────────────────────────
   * What a visitor sees during the stop is not the same on both sides: on Compose
   * the host port is freed with the container — the connection is refused; on
   * Kubernetes the Service and the Ingress outlive the pods — the ingress
   * controller answers 503. Neither can be imitated by the other without
   * destroying what the contract promises to keep (the proxy entry on one side,
   * the port reservation on the other). We document it here rather than disguise
   * it.
   *
   * Required, and not optional like `openFirewall()`: both runtimes have an honest
   * translation of the gesture. An optional method says "this runtime does not
   * have this capability" — that is not the case here, and suggesting it would
   * force the caller to plan for a case that does not exist.
   */
  stop(ctx: DriverContext, onLog: LogSink): Promise<void>;

  /**
   * Puts back in service what `stop()` stopped, in the state `deploy()` had left
   * it — same images, same volumes, same port, as many replicas as the AppSpec
   * asks for.
   *
   * Idempotent too: starting an application already running succeeds. Returns
   * when the services are **ready**, not when the order is given: that is what
   * lets the caller follow up with a health probe that means something.
   */
  start(ctx: DriverContext, onLog: LogSink): Promise<void>;

  // ─── target workloads ────────────────────────────────────────────────────────
  //
  // These three are not about a deployment but about the **machine**: they see
  // everything running, whether the panel deployed it or not. Hence
  // `TargetContext` rather than `DriverContext`.

  /**
   * Everything running on the target for this runtime, the panel included.
   *
   * Each workload says itself whether it is `managed`: it is the driver that knows
   * how to recognize its own signature on the machine, and nobody else.
   * Read-only, and short — a command, not a session.
   */
  listWorkloads(ctx: TargetContext): Promise<Workload[]>;

  /**
   * Deletes a workload and what it takes along.
   *
   * Must refuse a `managed` workload: the panel already holds its life cycle
   * elsewhere, and deleting it through this path would leave the database
   * convinced it is running. The refusal is a `DriverError`, not a silence.
   */
  removeWorkload(ctx: TargetContext, ref: WorkloadRef, onLog: LogSink): Promise<void>;

  /**
   * Fetches the most recent image and recreates the workload with the same
   * configuration. What "the same configuration" means is specific to each
   * runtime, and it is written in each implementation.
   *
   * Like `removeWorkload`, refuses a `managed` workload: updating a panel
   * application means redeploying it, not recreating it behind its back.
   */
  updateWorkload(ctx: TargetContext, ref: WorkloadRef, onLog: LogSink): Promise<void>;

  /**
   * Starts, stops or restarts a workload, without recreating anything.
   *
   * A `managed` workload can be **restarted** here — its state in the database
   * does not depend on it —, but neither stopped nor started: it is stopping the
   * application that holds `stopped_at`, and a stop through this path would leave
   * the panel believing it running. The refusal is a `DriverError`. What "stop"
   * means is specific to the runtime, and written in each implementation.
   */
  controlWorkload(
    ctx: TargetContext,
    ref: WorkloadRef,
    action: WorkloadControlAction,
    onLog: LogSink,
  ): Promise<void>;

  /**
   * The exact content of what runs: for each service of the application, the
   * digests (`sha256:…`) of its containers' or pods' images — those the registry
   * announces for a tag, in the same shape (multi-architecture index). It is what
   * tells whether a tag has moved since the deployment. Read-only; a service
   * without a container is absent from the result.
   */
  runningImages(ctx: DriverContext): Promise<RunningImage[]>;

  // ─── backups ─────────────────────────────────────────────────────────────
  // An application's data lives in volumes each runtime stores its own way —
  // named Docker volume, Kubernetes PVC. The worker knows nothing about that: it
  // asks the driver for a byte stream, or gives it one.
  // A non-zero exit code is a `DriverError`, with the end of stderr.

  /** Archive (`tar.gz`) of the content of an application volume, written to `sink`. */
  exportVolume(ctx: DriverContext, service: string, volume: string, sink: Writable): Promise<void>;

  /**
   * Replaces a volume's content with the archive read from `source`. To do with
   * the application stopped: a process writing in the meantime would have the
   * last word.
   */
  importVolume(
    ctx: DriverContext,
    service: string,
    volume: string,
    source: Readable,
  ): Promise<void>;

  /** Runs `command` (under `sh -c`) in the running service; its stdout goes to `sink`. */
  exportFromService(
    ctx: DriverContext,
    service: string,
    command: string,
    sink: Writable,
  ): Promise<void>;

  /** Runs `command` in the running service, with `source` as stdin. */
  importIntoService(
    ctx: DriverContext,
    service: string,
    command: string,
    source: Readable,
  ): Promise<void>;

  /** The last lines of a workload's log, timestamped. Read-only. */
  workloadLogs(ctx: TargetContext, ref: WorkloadRef, tail: number, onLine: LogSink): Promise<void>;

  /**
   * Runs a command in the workload — non-interactive, under `sh -c`. The command
   * **only** runs in the workload, never on the host: it is quoted for the
   * machine's shell (see `quoteForShell`). Returns the exit code; the output goes
   * out line by line, bounded in number and duration.
   */
  execInWorkload(
    ctx: TargetContext,
    ref: WorkloadRef,
    command: string,
    onLine: LogSink,
    options: WorkloadExecOptions,
  ): Promise<WorkloadExecResult>;

  /**
   * Removes what the runtime set up on the machine **to build** images, when no
   * build has used it for a long time — the duration is a driver policy, written
   * on its side.
   *
   * **Optional**, like `openFirewall()`: a runtime that builds without setting
   * anything up — the Docker daemon can build alone — has nothing to expire, and
   * does not implement it. The sweep that calls it does not know which runtime it
   * queries. Touches no application nor the images already built.
   */
  pruneIdleBuilder?(ctx: TargetContext, onLog: LogSink, now?: Date): Promise<BuilderPruneResult>;

  /**
   * Opens the port on the target's firewall.
   *
   * **Optional by design.** A runtime that exposes no host port has nothing to
   * open: it simply does not implement the method, and the caller that does not
   * find it moves on. It is a matter of driver capability, never an
   * `if (runtime === ...)` in the caller.
   */
  openFirewall?(ctx: DriverContext, port: number, onLog?: LogSink): Promise<void>;

  /** Closes the port. Counterpart of `openFirewall`, same optionality rule. */
  closeFirewall?(ctx: DriverContext, port: number, onLog?: LogSink): Promise<void>;
}

/** A failure attributable to the driver, with the context useful for diagnosis. */
export class DriverError extends Error {
  constructor(
    message: string,
    readonly runtime: RuntimeKind,
    readonly step: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'DriverError';
  }
}

/**
 * `deploy()` put the new version in place, but it did not become healthy in
 * time.
 *
 * For the pipeline, it is a failed healthcheck: automatic rollback applies.
 * Without this signal, a `deploy` failure would pass for a start that never
 * happened, where there is nothing to undo — which is wrong as soon as the
 * runtime replaces the services **before** waiting for their health. Only the
 * driver knows whether that is the case: so it is the one that says it.
 *
 * `diagnostics`: the scene captured before returning, like
 * `HealthResult.diagnostics` — the rollback that follows would wipe it.
 */
export class UnhealthyReleaseError extends DriverError {
  constructor(
    message: string,
    runtime: RuntimeKind,
    step: string,
    readonly diagnostics: string | null,
    cause?: unknown,
  ) {
    super(message, runtime, step, cause);
    this.name = 'UnhealthyReleaseError';
  }
}
