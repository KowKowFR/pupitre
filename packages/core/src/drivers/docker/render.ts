import { buildContextPath } from '../source-archive.js';
import type { UiLanguage } from '../../i18n.js';
import { stringify } from 'yaml';
import { WORKSPACE_PREFIX } from '../../naming.js';
import {
  exposedService,
  topologicalOrder,
  type AppSpec,
  type Service,
} from '../../spec/index.js';
import { isHttpProbed, probePort } from '../probe.js';
import { completeSecretValues } from '../secrets.js';
import type { RenderedFile } from '../types.js';
import {
  seconds,
  type ComposeFile,
  type ComposeService,
  type ComposeHealthcheck,
} from './compose-model.js';

/**
 * AppSpec → Compose translation.
 *
 * It is the only place in the project allowed to know Docker. Everything the
 * neutral spec cannot say — restart policy, network, image naming — is decided
 * here, because it is a runtime matter.
 */

/** Derived from the shared convention: a single definition of `app-`. */
export const PROJECT_PREFIX = WORKSPACE_PREFIX;

export function projectName(appSlug: string): string {
  return `${PROJECT_PREFIX}${appSlug}`;
}

export function networkName(appSlug: string): string {
  return `${projectName(appSlug)}-net`;
}

/** A volume's name, prefixed to stay unique on a shared target. */
export function volumeName(appSlug: string, service: string, volume: string): string {
  return `${projectName(appSlug)}-${service}-${volume}`;
}

/** An image built locally for a service to build. */
export function buildImageTag(appSlug: string, service: string, version: string): string {
  return `${projectName(appSlug)}/${service}:${version}`;
}

/**
 * UID/GID of the unprivileged account. The spec does not say it: it is a
 * runtime decision, like the restart policy.
 *
 * The K3s render sets the same value, but there it serves **two** uses:
 * imposing the process identity, and giving its group to the mounted volume
 * (`fsGroup`). Compose has no second use to offer — see `pinsRunAsUser()`.
 */
export const RUN_AS_UID = 1000;

/**
 * The counterpart of `allowPrivilegeEscalation: false`.
 *
 * It is **not** redundant with `cap_drop`. Measured on the target, a Docker
 * container without the option starts with `NoNewPrivs: 0` — a setuid binary
 * present in the image can therefore still regain what was just removed. The
 * option sets the bit to 1:
 *
 *     docker run --rm nginx:1.27-alpine grep NoNewPrivs /proc/1/status
 *     NoNewPrivs:  0
 *     docker run --rm --security-opt no-new-privileges:true … → NoNewPrivs: 1
 *
 * Checked harmless on `nginx`, `postgres`, `redis`, `httpd`, `mariadb`,
 * `wordpress` and `adminer`: their entry points drop privileges with
 * `gosu`/`su-exec`, which call `setuid()` as root and are not setuid binaries —
 * the flag does not bother them. An image that went through `su` or `sudo`,
 * which are setuid, would be the only one to suffer from it.
 */
const NO_NEW_PRIVILEGES = 'no-new-privileges:true';

/**
 * Capabilities given back to a container that keeps the identity chosen by its
 * image.
 *
 * The same list as the K3s render, for the same reason — checked here too,
 * `cap_drop: ALL` alone breaks the most ordinary official images:
 *
 *     nginx    : chown("/var/cache/nginx/client_temp", 101) failed (1: Operation not permitted)
 *     postgres : chmod: /var/run/postgresql: Operation not permitted
 *                error: failed switching to 'postgres': operation not permitted
 *
 * The pattern is always the same: start as root, prepare its directories, then
 * drop privileges. It needs these five capabilities and not one more — `CapEff`
 * drops from `a80425fb` (Docker's fourteen) to `cb`.
 *
 * `NET_BIND_SERVICE` is deliberately absent, as on the K3s side: Docker sets
 * `net.ipv4.ip_unprivileged_port_start=0` in the container, and an `nginx`
 * listening on 80 starts without it — checked on the target.
 */
const RETAINED_CAPABILITIES = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID'];

/**
 * Scratch space imposed by the read-only root.
 *
 * `exec` is explicit and it is not a hardening oversight: Docker's tmpfs is
 * `noexec` by default, whereas the `emptyDir` the K3s render mounts at the same
 * place is not. Leaving the default would make an application that runs
 * something from `/tmp` work on K3s and fail on Docker: exactly the behavior
 * divergence between runtimes the project forbids. The marginal hardening is not
 * worth that price.
 *
 * `mode=1777` repeats Docker's default, written so that it stops being an
 * implicit default.
 */
const TMP_SCRATCH = `/tmp:exec,mode=1777`;

/**
 * Hardening is only legitimate on what we know.
 *
 * On an image **we** build from a Dockerfile, we know what it writes and under
 * which account it runs. On a third-party image pulled from a registry, we know
 * none of that, and each constraint imposed blindly becomes a startup failure.
 */
function isOwnImage(service: Service): boolean {
  return service.source.type === 'dockerfile';
}

/**
 * Do we impose the process identity, or let the image choose?
 *
 * It is **the** question Compose asks differently from Kubernetes, and the only
 * accepted divergence between the two renders.
 *
 * On K3s, `fsGroup` makes a freshly provisioned volume writable by a container
 * running under its own uid: the kubelet chowns the mount point. **Compose has
 * no equivalent.** Measured on the target, a new named volume is
 * `root:root 0755` and stays so:
 *
 *     docker run -u 1000:1000 -v new:/data nginx:1.27-alpine touch /data/x
 *     touch: /data/x: Permission denied
 *
 * `group_add: 0` changes nothing — the directory is `0755`, the group has no
 * write bit. The only path that works is for the image to have prepared the
 * mount point itself: Docker then copies that directory's ownership into the new
 * volume. But the Dockerfile comes from the user, we cannot assume it.
 *
 * Hence the rule: we only impose the uid on images we build **and** that declare
 * no volume. Elsewhere, the image keeps its identity — and therefore gets the
 * five capabilities, which are precisely what its entry point needs to do by
 * hand what `fsGroup` would do for it.
 *
 * Imposing the uid everywhere would produce a container that starts then fails
 * at the first write: a regression, not hardening.
 */
function pinsRunAsUser(service: Service): boolean {
  return isOwnImage(service) && service.volumes.length === 0;
}

/**
 * Read-only root: only bearable on an image we build. Checked on the target,
 * `--read-only` on a third-party image fails right away — `nginx`:
 * `mkdir() "/var/cache/nginx/client_temp" failed (30: Read-only file system)`.
 * The criterion is therefore `isOwnImage()`, exactly as on the K3s side, and not
 * `pinsRunAsUser()`: a mounted volume stays writable whatever happens to the
 * root.
 */
function allowsReadOnlyRoot(service: Service): boolean {
  return isOwnImage(service);
}

/**
 * Sets the security context on a service.
 *
 * What **is not** written here is just as much a decision:
 *
 * - **Seccomp profile.** None to declare. Docker already applies one
 *   (`docker info` → `name=seccomp,profile=builtin`), and it is active without
 *   asking for anything: `grep Seccomp /proc/1/status` returns `2` (filter
 *   mode) in a container started without options. It is the K3s render's
 *   `RuntimeDefault`, under another name. Compose can anyway only say
 *   `seccomp:unconfined` or a JSON profile path: the only possible declaration
 *   would weaken what is already in place.
 * - **`privileged: false`.** It is Docker's default. Writing it would add
 *   nothing but one more field to read.
 * - **`fsGroup`.** No equivalent — see `pinsRunAsUser()`.
 */
function applySecurityContext(composeService: ComposeService, service: Service): void {
  composeService.security_opt = [NO_NEW_PRIVILEGES];

  // We start from zero in every case, then give back what was measured as
  // necessary. An image whose uid we pin needs nothing: it never starts as root,
  // so it has nothing to prepare before dropping privileges.
  composeService.cap_drop = ['ALL'];
  if (!pinsRunAsUser(service)) {
    composeService.cap_add = [...RETAINED_CAPABILITIES];
  }

  if (pinsRunAsUser(service)) {
    composeService.user = `${RUN_AS_UID}:${RUN_AS_UID}`;
  }

  if (allowsReadOnlyRoot(service)) {
    composeService.read_only = true;
    // Without a writable `/tmp`, almost no application runtime starts. Unless the
    // spec already mounts a volume there — the same caveat as the K3s render.
    if (!service.volumes.some((volume) => volume.mountPath === '/tmp')) {
      composeService.tmpfs = [TMP_SCRATCH];
    }
  }
}

/**
 * Probe run *inside* the container.
 *
 * Who is probed over HTTP and who over TCP is not decided here: it is
 * `isHttpProbed()`, shared with the K3s render. Only the *how* is left to this
 * render, which depends on what the image ships.
 *
 * HTTP: `wget`, otherwise `curl`, present in busybox as in most Debian bases. An
 * image with **neither** does exist though — `freshrss/freshrss`, seen on a real
 * target: its probe returned 127 forever, the container stayed `unhealthy` and
 * `up --wait` failed the deployment of an application that answered very well.
 * Lacking an HTTP tool, the probe then falls back on the TCP test below. It
 * **only** falls back in that case: a present `wget` that gets a 500 stays a
 * failure, it does not recover on an open port. The HTTP status is checked from
 * outside by `healthcheck()` at each deployment.
 *
 * TCP: `nc` then bash's `/dev/tcp` redirection. Both are needed and neither is
 * enough — `postgres:16-alpine` has `nc` but not `bash`, `postgres:16` and
 * `mariadb:11` (Debian) have `bash` but **neither `nc`, nor `wget`, nor
 * `curl`**. The old `nc || wget || curl` chain therefore found none of its three
 * commands on a Debian base: the shell returned 127, the container stayed
 * `unhealthy` forever, and the application service's
 * `depends_on: service_healthy` blocked with it. An HTTP fallback on a service
 * that does not speak HTTP would never have succeeded anyway: it is removed.
 */
function renderHealthcheck(spec: AppSpec, service: Service): ComposeHealthcheck {
  const port = probePort(service);
  const timeout = Math.max(1, service.healthcheck.timeoutSec);

  const tcp =
    `nc -z -w ${timeout} 127.0.0.1 ${port} 2>/dev/null ` +
    `|| bash -c 'exec 3<>/dev/tcp/127.0.0.1/${port}' 2>/dev/null`;
  const url = `http://127.0.0.1:${port}${service.healthcheck.path}`;

  const probe = isHttpProbed(spec, service)
    ? `if command -v wget >/dev/null 2>&1; then wget --spider -q -T ${timeout} ${url}; ` +
      `elif command -v curl >/dev/null 2>&1; then curl -fsS -m ${timeout} ${url} >/dev/null; ` +
      `else ${tcp}; fi`
    : tcp;

  return {
    test: ['CMD-SHELL', probe],
    interval: seconds(service.healthcheck.intervalSec),
    timeout: seconds(timeout),
    retries: service.healthcheck.retries,
    start_period: seconds(service.healthcheck.intervalSec * 2),
  };
}

export type RenderInput = {
  spec: AppSpec;
  appSlug: string;
  /** Port published on the host for the exposed service. `null` = no publication. */
  publishedPort: number | null;
  /** Publication address — see `DriverExposure.bindAddress`. Absent: all. */
  publishAddress?: string;
  /** Names of the secrets whose value the `.env` file will provide. */
  secretNames?: readonly string[];
  /** A repository's code is under `source/`: see `DriverContext.sourceInRelease`. */
  sourceInRelease?: boolean;
  /** The tag of the built images: the release (`releaseName()`). Default: the version. */
  imageTag?: string;
  /** The language of a render error (a secret without a value). Default: French. */
  language?: UiLanguage;
};

/** Pupitre's Compose file, always designated by its name (`-f`). */
export const COMPOSE_FILE = 'compose.yml';

export function renderComposeFile(input: RenderInput): ComposeFile {
  const { spec, appSlug, publishedPort } = input;
  const project = projectName(appSlug);
  const network = 'appnet';
  const exposed = exposedService(spec);

  const services: Record<string, ComposeService> = {};
  const volumes: Record<string, Record<string, never>> = {};

  // The topological order makes the file readable: a dependency always appears
  // before the service that declares it.
  for (const service of topologicalOrder(spec)) {
    const isExposed = service.name === exposed.name;

    const image =
      service.source.type === 'image'
        ? service.source.ref
        : buildImageTag(appSlug, service.name, input.imageTag ?? spec.version);

    const composeService: ComposeService = {
      image,
      // The restart policy is a runtime decision, not the spec's: that is why no
      // `restart` field exists in the AppSpec.
      restart: 'unless-stopped',
      networks: [network],
      expose: [String(service.port)],
      // `pupitre.` prefix since the renaming. The driver still reads the old `tp.*`:
      // a container set up before keeps its fingerprint, and the panel must keep
      // recognizing it as its own.
      labels: {
        'pupitre.app': appSlug,
        'pupitre.service': service.name,
        'pupitre.version': spec.version,
        'pupitre.managed-by': 'pupitre',
      },
    };

    if (service.source.type === 'dockerfile') {
      composeService.build = {
        context: buildContextPath(service.source.context, input.sourceInRelease),
        dockerfile: service.source.dockerfile,
      };
    }

    if (Object.keys(service.env).length > 0) {
      composeService.environment = { ...service.env };
    }

    // Secrets are never written into compose.yml: they arrive through a `.env` file
    // placed next to it, with mode 0600.
    if (service.secrets.length > 0) {
      composeService.env_file = ['./.env'];
    }

    if (isExposed && publishedPort !== null) {
      composeService.ports = [
        input.publishAddress
          ? `${input.publishAddress}:${publishedPort}:${service.port}`
          : `${publishedPort}:${service.port}`,
      ];
    }

    if (service.volumes.length > 0) {
      composeService.volumes = service.volumes.map((volume) => {
        const name = volumeName(appSlug, service.name, volume.name);
        volumes[name] = {};
        return `${name}:${volume.mountPath}`;
      });
    }

    if (service.dependsOn.length > 0) {
      composeService.depends_on = Object.fromEntries(
        service.dependsOn.map((dependency) => [dependency, { condition: 'service_healthy' }]),
      );
    }

    composeService.healthcheck = renderHealthcheck(spec, service);

    // After the volumes: the presence of a volume decides the imposed identity, and
    // a volume mounted on `/tmp` makes the scratch tmpfs useless.
    applySecurityContext(composeService, service);

    const deploy: ComposeDeployDraft = {};
    if (service.replicas > 1) deploy.replicas = service.replicas;
    deploy.resources = {
      limits: {
        cpus: (service.resources.cpuMilli / 1000).toFixed(3),
        memory: `${service.resources.memoryMi}M`,
      },
    };
    composeService.deploy = deploy;

    services[service.name] = composeService;
  }

  const file: ComposeFile = {
    name: project,
    services,
    networks: {
      [network]: { name: networkName(appSlug), driver: 'bridge' },
    },
  };

  if (Object.keys(volumes).length > 0) {
    file.volumes = volumes;
  }

  return file;
}

type ComposeDeployDraft = NonNullable<ComposeService['deploy']>;

/** Serializes the model. `lineWidth: 0` avoids unexpected line wraps. */
export function serializeComposeFile(file: ComposeFile): string {
  const header = [
    '# Generated by Pupitre — do not edit by hand.',
    `# Projet : ${file.name}`,
    '',
  ].join('\n');
  return `${header}${stringify(file, { lineWidth: 0, singleQuote: false })}`;
}

/** The secrets' `.env` file. Placed with mode 0600, never logged. */
export function serializeEnvFile(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([key, value]) => `${key}=${escapeEnvValue(value)}`)
    .join('\n')
    .concat('\n');
}

function escapeEnvValue(value: string): string {
  if (/^[A-Za-z0-9_.\-/:@]*$/.test(value)) return value;
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')}"`;
}

/** The complete set of files to place on the target. */
export function renderFiles(
  input: RenderInput & { secretValues?: Record<string, string> },
): RenderedFile[] {
  const files: RenderedFile[] = [
    {
      path: COMPOSE_FILE,
      content: serializeComposeFile(renderComposeFile(input)),
      mode: 0o644,
    },
  ];

  // Fails if a declared secret has no resolved value — see
  // `completeSecretValues()`. The render is the last place where the culprit can
  // still be named.
  const complete = completeSecretValues(input.spec, input.secretValues ?? {}, input.language);

  if (Object.keys(complete).length > 0) {
    files.push({
      path: '.env',
      content: serializeEnvFile(complete),
      mode: 0o600,
    });
  }

  return files;
}
