import { stringify } from 'yaml';
import { MANAGED_BY } from './render.js';

/**
 * The K3s runtime's image builder.
 *
 * ── The problem ──────────────────────────────────────────────────────────────
 *
 * CLAUDE.md decided: "images built on the target machine, no registry". On a
 * Docker target, the daemon can build *and* store, and that is it. On a K3s node
 * there is no Docker daemon: containerd can run an image and `k3s ctr` can
 * import one, but **nobody can build one**. Half of the gesture was therefore
 * missing.
 *
 * ── What we bring, and why that one ──────────────────────────────────────────
 *
 * BuildKit, deployed **in the cluster** by the driver itself. Three reasons to
 * prefer it to the other candidates:
 *
 * - **kaniko** cannot write into the node's containerd: it pushes to a registry,
 *   or writes a tar. Without a registry, we fall back on the tar — and kaniko is
 *   no longer maintained since 2024. No gain over BuildKit.
 * - **`nerdctl build`** assumes nerdctl *and* buildkitd installed on the node.
 *   The panel does not provision its targets; it has no way to put them there.
 * - **BuildKit in a pod** assumes nothing about the node except a cluster that
 *   accepts a privileged pod. The cluster pulls the builder's image itself. It is
 *   the only candidate that requires no prior installation.
 *
 * ── OCI worker, and not containerd worker ────────────────────────────────────
 *
 * BuildKit can talk directly to the node's containerd (`--containerd-worker`):
 * the built image would then land *by itself* in the `k8s.io` namespace,
 * without an intermediate tar. It is the elegant solution, and it was tried
 * first. It fails, and not for a trifle:
 *
 *   1. `RUN` steps are run by containerd's shim, which runs **on the host**. The
 *      mounts buildkitd prepares in the pod are not visible to it: "failed to
 *      mount rootfs component";
 *   2. making them visible requires `mountPropagation: Bidirectional` on
 *      `/var/lib/buildkit`, which the kubelet refuses if the node's root is not a
 *      shared mount. Measured on the test target: "path "/var/lib/buildkit" is
 *      mounted on "/" but it is not a shared mount".
 *
 * A Linux node under systemd does have `/` as `shared` — but not a node in a
 * container, and we have no way to know before trying. The OCI worker runs
 * `runc` **inside the pod**: nothing to propagate, nothing to assume about the
 * node's mount topology, and no containerd data path to guess. We pay for this
 * choice with a round trip through an OCI tar, which `k3s ctr images import`
 * then takes over — exactly the gesture the driver already made after
 * `docker save`.
 *
 * ── The tar does not travel over the network ─────────────────────────────────
 *
 * `kubectl exec ... -- cat` reads it from the pod and the pipe sends it directly
 * into `k3s ctr images import`, on the same machine. Nothing is pushed anywhere:
 * the "no registry" decision holds.
 */

/**
 * A separate namespace, and not `kube-system`.
 *
 * The builder belongs to no application — it serves every target of a cluster —
 * but it does not belong to the cluster either: it is the panel that set it up,
 * and `SYSTEM_NAMESPACES` protects precisely `kube-system` from what the panel
 * would do there.
 */
export const BUILDER_NAMESPACE = `${MANAGED_BY}-build`;

export const BUILDER_DEPLOYMENT = 'buildkitd';

/**
 * The date of the last build served, on the Deployment's metadata. It is what
 * expiry reads (`K3sDriver.pruneIdleBuilder`).
 */
export const BUILDER_LAST_BUILD_ANNOTATION = 'pupitre.io/last-build';

/**
 * Beyond 24 hours without a build, the builder is removed: its cache is no
 * longer worth the privileged pod that hosts it. The next build sets it up again
 * — one more minute, and the base images to download again.
 */
export const BUILDER_IDLE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * A pinned version, never `latest`: the builder is part of the chain that makes
 * the deployed images. An image changing underfoot would change a deployment's
 * result without any AppSpec having moved.
 */
export const BUILDKIT_IMAGE = 'moby/buildkit:v0.28.1';

/** The pod's working volume: context received and tar produced. */
const WORK_DIR = '/work';
const CONTEXT_DIR = `${WORK_DIR}/context`;
const IMAGE_TAR = `${WORK_DIR}/image.tar`;

/** Delimiter of the heredoc carrying the manifests. Quoted: no expansion. */
const HEREDOC = 'PUPITRE_BUILDER_MANIFEST';

/**
 * POSIX escaping in single quotes.
 *
 * Duplicated from `driver.ts` for the reason already written there: a module
 * that builds commands must not depend on the module that runs them.
 */
function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function builderNamespaceManifest(): string {
  return stringify({
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: {
      name: BUILDER_NAMESPACE,
      labels: { 'app.kubernetes.io/managed-by': MANAGED_BY },
    },
  });
}

/**
 * The builder pod's `spec`, alone and complete.
 *
 * Isolated because the preflight needs it **outside** its Deployment: the
 * PodSecurity admission control validates Pods, not controllers. A
 * `--dry-run=server` on the Deployment exits with code 0 and a mere warning on
 * stderr, even under `enforce=restricted` — measured. The same `spec` submitted
 * as a Pod is flatly refused, code 1. That is therefore the one submitted.
 */
function builderPodSpec(): Record<string, unknown> {
  return {
    containers: [
      {
        name: BUILDER_DEPLOYMENT,
        image: BUILDKIT_IMAGE,
        args: [
          // OCI worker: `runc` runs in this pod. See the module header for what the
          // containerd worker would have required of the node.
          '--oci-worker=true',
          '--containerd-worker=false',
          '--addr=unix:///run/buildkit/buildkitd.sock',
        ],
        // BuildKit creates namespaces and mounts overlays: without privilege, no `RUN`
        // step starts. It is the builder's price, and it is what the preflight checks
        // the cluster's admission accepts.
        securityContext: { privileged: true },
        volumeMounts: [
          { name: 'buildkit', mountPath: '/var/lib/buildkit' },
          { name: 'work', mountPath: WORK_DIR },
        ],
        // The only state that is authoritative: buildctl answers, so the worker is
        // registered. A "Running" pod whose daemon has not finished registering would
        // fail the first build.
        readinessProbe: {
          exec: { command: ['buildctl', 'debug', 'workers'] },
          initialDelaySeconds: 2,
          periodSeconds: 3,
          failureThreshold: 40,
        },
        resources: {
          requests: { cpu: '100m', memory: '256Mi' },
        },
      },
    ],
    volumes: [
      // `emptyDir` and not a PVC: the layer cache lives as long as the pod, which is
      // enough to chain the services of one AppSpec without downloading each base
      // image again. A PVC would make the cache survive restarts, at the price of a
      // volume nobody would ever claim — an accepted trade-off.
      { name: 'buildkit', emptyDir: {} },
      { name: 'work', emptyDir: {} },
    ],
  };
}

/**
 * The Pod the preflight submits to admission, and never creates.
 *
 * The same `spec` as the real builder, to the letter: a check on something else
 * would prove nothing.
 */
export function builderAdmissionProbeManifest(): string {
  return stringify({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: `${BUILDER_DEPLOYMENT}-preflight`,
      namespace: BUILDER_NAMESPACE,
    },
    spec: builderPodSpec(),
  });
}

/**
 * The builder's Deployment, stamped with the build that sets it up or finds it.
 *
 * The date is in the applied manifest, and not set afterwards by a
 * `kubectl annotate`: use and existence are then **a single write**. Expiry
 * deletes conditionally on the version it read; a build that claims it in the
 * meantime changes that version, and the deletion is refused. On the
 * Deployment's metadata, not on the pod template: changing it restarts nothing.
 */
export function builderDeploymentManifest(lastBuild: Date): string {
  return stringify({
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: BUILDER_DEPLOYMENT,
      namespace: BUILDER_NAMESPACE,
      annotations: { [BUILDER_LAST_BUILD_ANNOTATION]: lastBuild.toISOString() },
      // Deliberately **without** `app.kubernetes.io/managed-by`: that label makes a
      // workload "managed by the panel" in the workloads screen's eyes, which then
      // refuses to delete it and points to destroying the matching deployment — but
      // there is none. The builder must on the contrary stay deletable by hand: the
      // next build sets it up again. The namespace's name already says where it comes
      // from.
      labels: {
        'app.kubernetes.io/name': BUILDER_DEPLOYMENT,
        'app.kubernetes.io/component': 'image-builder',
      },
    },
    spec: {
      replicas: 1,
      // `Recreate` and not `RollingUpdate`: two buildkitd would fight over the
      // `--root` lock, and the new one would crash on "could not lock buildkitd.lock".
      // Measured, not assumed.
      strategy: { type: 'Recreate' },
      selector: { matchLabels: { 'app.kubernetes.io/name': BUILDER_DEPLOYMENT } },
      template: {
        metadata: { labels: { 'app.kubernetes.io/name': BUILDER_DEPLOYMENT } },
        spec: builderPodSpec(),
      },
    },
  });
}

/** `kubectl apply` fed by a heredoc: nothing to place on the target. */
export function applyManifestCommand(manifest: string, dryRun = false): string {
  return [
    `kubectl apply ${dryRun ? '--dry-run=server ' : ''}-f - <<'${HEREDOC}'`,
    manifest.trimEnd(),
    HEREDOC,
  ].join('\n');
}

export function rolloutStatusCommand(timeout: string): string {
  return (
    `kubectl -n ${BUILDER_NAMESPACE} rollout status ` +
    `deploy/${BUILDER_DEPLOYMENT} --timeout=${timeout}`
  );
}

/**
 * The build context travels through `kubectl exec`'s stdin.
 *
 * It is already on the node — `upload()` placed it there — but in the **node's**
 * file system, not the pod's. A `hostPath` would make it visible without a copy;
 * we do not do it, because a `hostPath` on the deployment root would give the
 * builder read access to every release of every application, rendered secrets
 * included. A tar in a pipe only carries the context of the service being built.
 */
export function pushContextCommand(hostContextDir: string): string {
  const unpack = `rm -rf ${CONTEXT_DIR} && mkdir -p ${CONTEXT_DIR} && tar -xf - -C ${CONTEXT_DIR}`;
  return (
    `tar -C ${quote(hostContextDir)} -cf - . | ` +
    `kubectl -n ${BUILDER_NAMESPACE} exec -i deploy/${BUILDER_DEPLOYMENT} -- sh -c ${quote(unpack)}`
  );
}

/**
 * `--output type=oci` rather than `type=image`: the OCI worker has no image
 * store to save the result in. The name travels in the tar's index, and it is
 * what `ctr images import` will take over.
 */
export function buildCommand(tag: string, dockerfile: string): string {
  return (
    `kubectl -n ${BUILDER_NAMESPACE} exec deploy/${BUILDER_DEPLOYMENT} -- ` +
    'buildctl build --frontend dockerfile.v0 ' +
    `--local context=${CONTEXT_DIR} --local dockerfile=${CONTEXT_DIR} ` +
    `--opt filename=${quote(dockerfile)} ` +
    `--output ${quote(`type=oci,name=${tag},dest=${IMAGE_TAR}`)}`
  );
}

/**
 * The tar leaves the pod and enters containerd without touching the node's disk.
 *
 * `-n k8s.io` is explicit even though `k3s ctr` already has it by default: it is
 * **the** point of the problem. An image imported into another namespace is
 * invisible to the kubelet, and the pod would stay in `ImagePullBackOff` looking
 * on docker.io for an image that is already on the machine.
 */
export function importCommand(): string {
  return (
    `kubectl -n ${BUILDER_NAMESPACE} exec deploy/${BUILDER_DEPLOYMENT} -- cat ${IMAGE_TAR} | ` +
    `k3s ctr -n ${K3S_IMAGE_NAMESPACE} images import -`
  );
}

/** The kubelet's containerd namespace: where the images must be. */
export const K3S_IMAGE_NAMESPACE = 'k8s.io';

/**
 * k3s's embedded containerd. It is **not** `/run/containerd/containerd.sock`,
 * where tools look for it by default — hence scanners that found no built
 * image. Reserved to root.
 */
export const K3S_CONTAINERD_ADDRESS = '/run/k3s/containerd/containerd.sock';

// ─── expiration ──────────────────────────────────────────────────────────────

/** What expiry reads from the builder: enough to date its last use, and delete it conditionally. */
export type BuilderState = {
  /** The last build, or the creation of a builder set up before builds were stamped. */
  lastUsedAt: Date;
  /** The object's version read: the deletion only succeeds if it has not moved. */
  resourceVersion: string;
};

/**
 * A `last build date|creation|version` line — empty if the builder does not
 * exist, namespace included (`--ignore-not-found`).
 */
export function builderStateCommand(): string {
  const annotation = BUILDER_LAST_BUILD_ANNOTATION.replaceAll('.', '\\.');
  return (
    `kubectl -n ${BUILDER_NAMESPACE} get deploy/${BUILDER_DEPLOYMENT} --ignore-not-found ` +
    `-o jsonpath='{.metadata.annotations.${annotation}}{"|"}{.metadata.creationTimestamp}{"|"}{.metadata.resourceVersion}'`
  );
}

/** `null`: no builder. An unreadable date counts as its creation, then as absence. */
export function parseBuilderState(stdout: string): BuilderState | null {
  const [annotated = '', created = '', resourceVersion = ''] = stdout.trim().split('|');
  if (!resourceVersion.trim()) return null;
  const at = (value: string) => {
    const time = Date.parse(value.trim());
    return Number.isNaN(time) ? null : new Date(time);
  };
  const lastUsedAt = at(annotated) ?? at(created);
  return lastUsedAt ? { lastUsedAt, resourceVersion: resourceVersion.trim() } : null;
}

/**
 * Deletes the builder's Deployment — its pods with it, its cache too — provided
 * it is still at the version read. Otherwise the API answers `Conflict`: a build
 * just claimed it, it stays. The empty namespace stays too: recreating it at
 * each build would mean waiting for its end of life.
 */
export function deleteIdleBuilderCommand(resourceVersion: string): string {
  const body = JSON.stringify({
    kind: 'DeleteOptions',
    apiVersion: 'v1',
    propagationPolicy: 'Background',
    preconditions: { resourceVersion },
  });
  return [
    `kubectl delete --raw /apis/apps/v1/namespaces/${BUILDER_NAMESPACE}/deployments/${BUILDER_DEPLOYMENT} -f - <<'${HEREDOC}'`,
    body,
    HEREDOC,
  ].join('\n');
}

/** The tar weighs as much as the image: we do not leave it in the pod. */
export function discardTarCommand(): string {
  return (
    `kubectl -n ${BUILDER_NAMESPACE} exec deploy/${BUILDER_DEPLOYMENT} -- ` +
    `rm -f ${IMAGE_TAR}`
  );
}
