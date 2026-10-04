import { stringify } from 'yaml';
import type { UiLanguage } from '../../i18n.js';
import { WORKSPACE_PREFIX } from '../../naming.js';
import {
  exposedService,
  serviceSecretNames,
  topologicalOrder,
  type AppSpec,
  type Service,
} from '../../spec/index.js';
import { isHttpProbed, probePort } from '../probe.js';
import { completeSecretValues } from '../secrets.js';
import type { RenderedFile } from '../types.js';
import {
  mebibytes,
  milliCpu,
  type ConfigMapManifest,
  type Container,
  type ContainerSecurityContext,
  type DeploymentManifest,
  type EnvFromSource,
  type KubeManifest,
  type NamespaceManifest,
  type NetworkPolicyManifest,
  type PersistentVolumeClaimManifest,
  type PodSecurityContext,
  type PodVolume,
  type Probe,
  type SecretManifest,
  type ServiceManifest,
  type VolumeMount,
} from './manifest-model.js';

/**
 * AppSpec → Kubernetes manifests translation.
 *
 * The exact counterpart of `docker/render.ts`: it is the only place in the
 * project, with the driver, allowed to know Kubernetes. Everything the neutral
 * spec cannot say — storage class, update strategy, security context, ingress
 * class — is decided here, because it is a runtime matter.
 *
 * Both renders start from the **same** fixtures, without one more field.
 */

/** Derived from the shared convention: a single definition of `app-`. */
export const NAMESPACE_PREFIX = WORKSPACE_PREFIX;

/** Directory, in the release, where the manifests land. */
export const MANIFEST_DIR = 'k8s';

export const MANAGED_BY = 'pupitre';

/**
 * The value from before the renaming, still set on everything deployed so far.
 * The driver's selectors accept both — a `rollout restart` or a log follow that
 * only saw the new one would silently miss a live application, which is worse
 * than an error: it is a success that did nothing.
 */
export const LEGACY_MANAGED_BY = 'bootstrap-tp';

/**
 * A label selector that recognizes both generations. `kubectl` accepts the
 * set-based form; it avoids running two commands and merging their outputs.
 */
export const MANAGED_SELECTOR =
  `app.kubernetes.io/managed-by in (${MANAGED_BY},${LEGACY_MANAGED_BY})`;

/** K3s's default storage class. */
export const DEFAULT_STORAGE_CLASS = 'local-path';

/** PVC size used when the AppSpec gives none. */
export const DEFAULT_VOLUME_SIZE = '1Gi';

/**
 * UID/GID of the unprivileged account. The spec does not say it: it is a
 * runtime decision, like the restart policy on the Compose side.
 *
 * It serves two uses not to be confused: the process identity, imposed only on
 * the images we build, and the volumes' `fsGroup`, set on every pod. See
 * `podSecurityContext()`.
 */
export const RUN_AS_UID = 1000;

/** Namespace de l'application. Convention CLAUDE.md : `app-{slug}`. */
export function namespaceName(appSlug: string): string {
  return `${NAMESPACE_PREFIX}${appSlug}`;
}

/**
 * Image built on the node. Same convention as the Docker driver: without a
 * registry, the tag only needs to be unique on the machine.
 */
export function builtImageTag(appSlug: string, service: string, version: string): string {
  return `${namespaceName(appSlug)}/${service}:${version}`;
}

export function configMapName(service: string): string {
  return `${service}-env`;
}

export function secretName(service: string): string {
  return `${service}-secrets`;
}

/** The namespace already isolates: no need to prefix with the slug as on Docker. */
export function pvcName(service: string, volume: string): string {
  return `${service}-${volume}`;
}

/**
 * A Kubernetes label value is stricter than a semver: `1.0.0+build` contains a
 * forbidden `+`. We sanitize rather than refuse a valid AppSpec — the field is
 * only informative.
 */
export function labelSafe(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 63);
  return cleaned.replace(/^[^A-Za-z0-9]+/, '').replace(/[^A-Za-z0-9]+$/, '') || 'unknown';
}

/**
 * Selector labels: **immutable**. The version is deliberately absent from them,
 * since a Deployment's `spec.selector` can no longer change after creation.
 */
export function selectorLabels(appSlug: string, serviceName: string): Record<string, string> {
  return {
    'app.kubernetes.io/name': serviceName,
    'app.kubernetes.io/instance': appSlug,
  };
}

/** Standard labels set on every resource. */
export function standardLabels(
  appSlug: string,
  serviceName: string,
  version: string,
): Record<string, string> {
  return {
    ...selectorLabels(appSlug, serviceName),
    'app.kubernetes.io/version': labelSafe(version),
    'app.kubernetes.io/part-of': appSlug,
    'app.kubernetes.io/managed-by': MANAGED_BY,
  };
}

export type RenderInput = {
  spec: AppSpec;
  appSlug: string;
  /** The language of a render error (a secret without a value). Default: French. */
  language?: UiLanguage;
  /**
   * Values of the declared secrets. A missing value **fails** the render, as on
   * the Docker side: see `completeSecretValues()`.
   */
  secretValues?: Record<string, string>;
  /**
   * The port published on the nodes for the entry point, when a remote proxy must
   * reach it (`DriverExposure.byPort`). Absent: ClusterIP only.
   */
  publishedPort?: number | null;
  /**
   * The only address this port can be reached from (`DriverExposure.allowFrom`).
   * A NodePort listens on every node and goes before the machine's firewall: it
   * is a NetworkPolicy that restricts it.
   */
  allowFrom?: string | null;
  /**
   * The tag of the built images: the release (`releaseName()`), specific to each
   * deployment — the pods' template changes with it, and they are replaced.
   * Default: the AppSpec's version.
   */
  imageTag?: string;
};

/** The name of the NetworkPolicy that reserves the entry point to the proxy. */
export const PROXY_POLICY_NAME = 'pupitre-proxy-only';

function renderProbe(service: Service, http: boolean, initialDelaySeconds: number): Probe {
  const port = probePort(service);
  const probe: Probe = {
    ...(http
      ? { httpGet: { path: service.healthcheck.path, port, scheme: 'HTTP' as const } }
      : { tcpSocket: { port } }),
    initialDelaySeconds,
    periodSeconds: service.healthcheck.intervalSec,
    timeoutSeconds: service.healthcheck.timeoutSec,
    failureThreshold: service.healthcheck.retries,
  };
  return probe;
}

/**
 * Hardening is only legitimate on what we know.
 *
 * On an image **we** build from a Dockerfile, we know what it writes, under which
 * account it runs, what its entry point needs: we can therefore lock everything
 * down. On a third-party image pulled from a registry (`postgres`, `nginx`,
 * `mariadb`, `wordpress`…), we know none of that, and each constraint imposed
 * blindly becomes a startup failure — on one runtime only, while the same
 * AppSpec runs on Docker. It is exactly what the project's three abstractions
 * exist to prevent.
 *
 * `isOwnImage()` is therefore the question asked of each field of the security
 * context, not only of the read-only root.
 */
function isOwnImage(service: Service): boolean {
  return service.source.type === 'dockerfile';
}

/** Read-only root: only bearable on an image we build. */
function allowsReadOnlyRoot(service: Service): boolean {
  return isOwnImage(service);
}

/**
 * Capabilities given back to third-party images.
 *
 * Measured on the test cluster, `drop: ALL` alone is enough to break the most
 * ordinary official images:
 *
 *     nginx    : chown("/var/cache/nginx/client_temp", 101) failed (1: Operation not permitted)
 *     postgres : chmod: /var/run/postgresql: Operation not permitted
 *
 * Their entry point starts as root, prepares its directories, then drops its
 * privileges — that is the standard pattern, and it needs these five
 * capabilities and not one more. Docker grants fourteen by default (`NET_RAW`,
 * `MKNOD`, `SYS_CHROOT`, `SETPCAP`, `SETFCAP`, `KILL`… included): even widened,
 * K3s stays strictly more closed than the other runtime.
 *
 * `NET_BIND_SERVICE` is deliberately absent: the kubelet sets
 * `net.ipv4.ip_unprivileged_port_start=0` in the sandbox, and an `nginx`
 * listening on 80 starts without it — checked on the target.
 */
const THIRD_PARTY_CAPABILITIES = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID'];

/**
 * The pod's runtime identity.
 *
 * The four fields are not of the same nature, and are therefore not decided
 * together:
 *
 * - `runAsNonRoot`, `runAsUser`, `runAsGroup` **choose the account** the process
 *   starts under. On a third-party image, it is a lost bet: neither its tree nor
 *   its entry point belong to us, and the kubelet even refuses to start a
 *   container whose image declares `root` when `runAsNonRoot` is set. We only
 *   impose them on our own images.
 * - `fsGroup` does not touch the process identity: it gives the **mounted
 *   volume** the indicated group (and adds it to the container's supplementary
 *   groups). That is precisely what makes a freshly provisioned PVC —
 *   `root:root 0755` — writable by a container running under its own uid.
 *   Removing it would be the only one of these four decisions to break
 *   something: it stays unconditional.
 * - `seccompProfile` depends on no identity, and Docker applies its own default
 *   profile: unconditional there too.
 */
function podSecurityContext(service: Service): PodSecurityContext {
  return {
    ...(isOwnImage(service)
      ? { runAsNonRoot: true, runAsUser: RUN_AS_UID, runAsGroup: RUN_AS_UID }
      : {}),
    fsGroup: RUN_AS_UID,
    seccompProfile: { type: 'RuntimeDefault' },
  };
}

function containerSecurityContext(service: Service): ContainerSecurityContext {
  return {
    allowPrivilegeEscalation: false,
    privileged: false,
    readOnlyRootFilesystem: allowsReadOnlyRoot(service),
    capabilities: isOwnImage(service)
      ? { drop: ['ALL'] }
      : { drop: ['ALL'], add: [...THIRD_PARTY_CAPABILITIES] },
  };
}

function renderNamespace(input: RenderInput): NamespaceManifest {
  const { spec, appSlug } = input;
  return {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: {
      name: namespaceName(appSlug),
      labels: standardLabels(appSlug, appSlug, spec.version),
    },
  };
}

function renderConfigMap(input: RenderInput, service: Service): ConfigMapManifest | null {
  if (Object.keys(service.env).length === 0) return null;
  const { spec, appSlug } = input;

  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: configMapName(service.name),
      namespace: namespaceName(appSlug),
      labels: standardLabels(appSlug, service.name, spec.version),
    },
    data: { ...service.env },
  };
}

function renderSecret(input: RenderInput, service: Service): SecretManifest | null {
  if (service.secrets.length === 0) return null;
  const { spec, appSlug } = input;
  // `renderManifests()` already completed and validated the table: each declared
  // name is in it, otherwise the render would have failed before getting here.
  const values = input.secretValues ?? {};

  // The names as the image expects them: an alias is a Secret key like any other,
  // and `completeSecretValues()` already gave it its root's value. Kubernetes
  // interpolates nothing — it receives the complete map.
  const stringData: Record<string, string> = {};
  for (const name of serviceSecretNames(service)) {
    stringData[name] = values[name] ?? '';
  }

  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: secretName(service.name),
      namespace: namespaceName(appSlug),
      labels: standardLabels(appSlug, service.name, spec.version),
    },
    type: 'Opaque',
    stringData,
  };
}

function renderClaims(input: RenderInput, service: Service): PersistentVolumeClaimManifest[] {
  const { spec, appSlug } = input;

  return service.volumes.map((volume) => ({
    apiVersion: 'v1' as const,
    kind: 'PersistentVolumeClaim' as const,
    metadata: {
      name: pvcName(service.name, volume.name),
      namespace: namespaceName(appSlug),
      labels: standardLabels(appSlug, service.name, spec.version),
    },
    spec: {
      // `local-path` can only do ReadWriteOnce: the volume follows the node hosting
      // the pod. It is K3s's default, and the AppSpec asks for no more.
      accessModes: ['ReadWriteOnce'],
      storageClassName: DEFAULT_STORAGE_CLASS,
      resources: { requests: { storage: volume.size ?? DEFAULT_VOLUME_SIZE } },
    },
  }));
}

function renderDeployment(input: RenderInput, service: Service): DeploymentManifest {
  const { spec, appSlug } = input;
  const http = isHttpProbed(spec, service);

  const image =
    service.source.type === 'image'
      ? service.source.ref
      : builtImageTag(appSlug, service.name, input.imageTag ?? spec.version);

  const envFrom: EnvFromSource[] = [];
  if (Object.keys(service.env).length > 0) {
    envFrom.push({ configMapRef: { name: configMapName(service.name) } });
  }
  if (service.secrets.length > 0) {
    envFrom.push({ secretRef: { name: secretName(service.name) } });
  }

  const volumeMounts: VolumeMount[] = service.volumes.map((volume) => ({
    name: volume.name,
    mountPath: volume.mountPath,
  }));
  const volumes: PodVolume[] = service.volumes.map((volume) => ({
    name: volume.name,
    persistentVolumeClaim: { claimName: pvcName(service.name, volume.name) },
  }));

  // Read-only root: `/tmp` has to be made writable, otherwise almost no
  // application runtime starts. Unless the spec already mounts a volume there.
  if (
    allowsReadOnlyRoot(service) &&
    !service.volumes.some((volume) => volume.mountPath === '/tmp')
  ) {
    volumeMounts.push({ name: 'tmp-scratch', mountPath: '/tmp' });
    volumes.push({ name: 'tmp-scratch', emptyDir: {} });
  }

  const container: Container = {
    name: service.name,
    image,
    // Without a registry, the built image only exists in the node's containerd:
    // `Always` would look for it on docker.io and fail.
    imagePullPolicy: 'IfNotPresent',
    ports: [
      { name: http ? 'http' : 'tcp', containerPort: service.port, protocol: 'TCP' },
    ],
    ...(envFrom.length > 0 ? { envFrom } : {}),
    resources: {
      requests: {
        cpu: milliCpu(service.resources.cpuMilli),
        memory: mebibytes(service.resources.memoryMi),
      },
      limits: {
        cpu: milliCpu(service.resources.cpuMilli),
        memory: mebibytes(service.resources.memoryMi),
      },
    },
    ...(volumeMounts.length > 0 ? { volumeMounts } : {}),
    readinessProbe: renderProbe(service, http, service.healthcheck.intervalSec),
    livenessProbe: renderProbe(service, http, service.healthcheck.intervalSec * 2),
    securityContext: containerSecurityContext(service),
  };
  container.readinessProbe.successThreshold = 1;

  // A `local-path` volume is ReadWriteOnce: two pods cannot mount it at the same
  // time. `Recreate` avoids the rolling update's deadlock.
  const usesClaim = service.volumes.length > 0;

  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: service.name,
      namespace: namespaceName(appSlug),
      labels: standardLabels(appSlug, service.name, spec.version),
    },
    spec: {
      replicas: service.replicas,
      selector: { matchLabels: selectorLabels(appSlug, service.name) },
      strategy: usesClaim
        ? { type: 'Recreate' }
        : { type: 'RollingUpdate', rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } },
      // `rollback()` relies on `kubectl rollout undo`: without history, it would have
      // nothing to go back to.
      revisionHistoryLimit: 10,
      template: {
        metadata: { labels: standardLabels(appSlug, service.name, spec.version) },
        spec: {
          securityContext: podSecurityContext(service),
          containers: [container],
          ...(volumes.length > 0 ? { volumes } : {}),
        },
      },
    },
  };
}

function renderService(input: RenderInput, service: Service): ServiceManifest {
  const { spec, appSlug } = input;
  const http = isHttpProbed(spec, service);
  // The entry point only, and only when a proxy outside the cluster must reach
  // it: a port published on the nodes.
  const nodePort =
    input.publishedPort && service.name === entrypointService(spec).name
      ? input.publishedPort
      : null;

  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: service.name,
      namespace: namespaceName(appSlug),
      labels: standardLabels(appSlug, service.name, spec.version),
    },
    spec: {
      // ClusterIP usually: the cluster's proxy reaches this Service, hence an
      // `allocatePort()` returning `null` and an `upstream()` returning the Service. A
      // NodePort when the proxy is on another machine.
      type: nodePort ? 'NodePort' : 'ClusterIP',
      // Otherwise the node hides the original address, and the NetworkPolicy can no
      // longer tell the proxy from the rest of the world. A Pupitre target is a
      // machine: the pod is on the node we reach.
      ...(nodePort ? { externalTrafficPolicy: 'Local' as const } : {}),
      selector: selectorLabels(appSlug, service.name),
      ports: [
        {
          name: http ? 'http' : 'tcp',
          port: service.port,
          targetPort: service.port,
          protocol: 'TCP',
          ...(nodePort ? { nodePort } : {}),
        },
      ],
    },
  };
}

/**
 * The entry point published on the nodes only accepts, from outside, the proxy
 * that serves it; the application's other pods reach it as before. The
 * kubelet's probes come from the node itself, which the controller lets through.
 */
export function renderProxyPolicy(input: RenderInput): NetworkPolicyManifest | null {
  if (!input.publishedPort || !input.allowFrom) return null;
  const { spec, appSlug } = input;
  const entrypoint = entrypointService(spec);
  const cidr = `${input.allowFrom}/${input.allowFrom.includes(':') ? 128 : 32}`;
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: PROXY_POLICY_NAME,
      namespace: namespaceName(appSlug),
      labels: standardLabels(appSlug, entrypoint.name, spec.version),
    },
    spec: {
      podSelector: { matchLabels: selectorLabels(appSlug, entrypoint.name) },
      policyTypes: ['Ingress'],
      ingress: [
        { from: [{ podSelector: {} }] },
        { from: [{ ipBlock: { cidr } }], ports: [{ protocol: 'TCP', port: entrypoint.port }] },
      ],
    },
  };
}

/**
 * Manifests in application order: the namespace first, the configuration next,
 * the workloads last. `kubectl apply -f <dir>` follows the files' lexicographic
 * order — hence the numeric prefixes.
 */
export function renderManifests(rawInput: RenderInput): KubeManifest[] {
  // A secret declared without a resolved value fails the render, naming it.
  const input: RenderInput = {
    ...rawInput,
    secretValues: completeSecretValues(
      rawInput.spec,
      rawInput.secretValues ?? {},
      rawInput.language,
    ),
  };

  const manifests: KubeManifest[] = [renderNamespace(input)];
  const services = topologicalOrder(input.spec);

  for (const service of services) {
    const configMap = renderConfigMap(input, service);
    if (configMap) manifests.push(configMap);
  }
  for (const service of services) {
    const secret = renderSecret(input, service);
    if (secret) manifests.push(secret);
  }
  for (const service of services) {
    manifests.push(...renderClaims(input, service));
  }
  for (const service of services) {
    manifests.push(renderDeployment(input, service));
  }
  for (const service of services) {
    manifests.push(renderService(input, service));
  }
  const policy = renderProxyPolicy(input);
  if (policy) manifests.push(policy);

  // No Ingress here: a domain is a route, set by the target's reverse proxy
  // (`@pupitre/core/proxy`) toward the Service rendered above.
  return manifests;
}

/**
 * Serializes a manifest.
 *
 * `version: '1.1'` is not a detail: the Kubernetes API reads YAML with a **1.1**
 * parser, where `y`, `no`, `on`, `off` are booleans and `12:30` a sexagesimal
 * number. A password equal to `y`, serialized in 1.2, therefore goes out as
 * `true` and the API refuses the Secret. Serializing in 1.1 forces quotes where
 * the parser on the other side needs them.
 *
 * `lineWidth: 0` also avoids unexpected line wraps.
 */
export function serializeManifest(manifest: KubeManifest): string {
  const where = manifest.metadata.namespace
    ? `${manifest.metadata.namespace}/${manifest.metadata.name}`
    : manifest.metadata.name;
  const header = [
    '# Généré par Pupitre — ne pas éditer à la main.',
    `# ${manifest.kind} ${where}`,
    '',
  ].join('\n');
  return `${header}${stringify(manifest, { lineWidth: 0, singleQuote: false, version: '1.1' })}`;
}

/**
 * A manifest's file name. The numeric prefix carries the application order, the
 * suffix makes the file recognizable in the logs.
 */
export function manifestFileName(manifest: KubeManifest): string {
  const order: Record<KubeManifest['kind'], number> = {
    Namespace: 0,
    ConfigMap: 10,
    Secret: 20,
    PersistentVolumeClaim: 30,
    Deployment: 40,
    Service: 50,
    NetworkPolicy: 55,
    Ingress: 60,
  };
  const kind = manifest.kind.toLowerCase();
  return `${MANIFEST_DIR}/${order[manifest.kind]}-${kind}-${manifest.metadata.name}.yaml`;
}

/**
 * Path of the namespace manifest in the release.
 *
 * The driver applies it alone before the rest: `kubectl apply -f <dir>` follows
 * lexicographic order, but we do not bet the namespace creation on a naming
 * convention. A test locks the agreement between the two.
 */
export function namespaceFilePath(appSlug: string): string {
  return `${MANIFEST_DIR}/0-namespace-${namespaceName(appSlug)}.yaml`;
}

/** The complete set of files to place on the target. */
export function renderFiles(input: RenderInput): RenderedFile[] {
  return renderManifests(input).map((manifest) => ({
    path: manifestFileName(manifest),
    content: serializeManifest(manifest),
    // A Secret contains values in clear in `stringData`: it must not be readable by
    // everyone on the target, like the `.env` on the Docker side.
    mode: manifest.kind === 'Secret' ? 0o600 : 0o644,
  }));
}

/** The services the driver must build before deploying. */
export function buildableServices(spec: AppSpec): Service[] {
  return spec.services.filter((service) => service.source.type === 'dockerfile');
}

/** Service through which the application is reached from outside. */
export function entrypointService(spec: AppSpec): Service {
  if (spec.ingress) {
    const target = spec.services.find(
      (service) => service.name === spec.ingress?.targetService,
    );
    if (target) return target;
  }
  return exposedService(spec);
}
