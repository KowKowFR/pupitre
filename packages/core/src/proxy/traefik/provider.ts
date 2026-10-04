import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { ufwAllowPort, UFW_MARKER } from '../../drivers/ufw.js';
import type { LogSink } from '../../drivers/types.js';
import { exec, execPipe } from '../../ssh/client.js';
import {
  ensureDirectory as ensureDirectoryAs,
  httpCode,
  removeFile as removeFileAs,
  writeFile as writeFileAs,
} from '../host.js';
import { firstLine, shellQuote } from '../../shell.js';
import { isIPv4 } from '../model.js';
import {
  TRAEFIK_PROBE,
  traefikConfigSchema,
  type TraefikConfig,
  type TraefikFileConfig,
  type TraefikKubernetesConfig,
} from './config.js';
import { probeRoute } from '../probe.js';
import { listOf } from '../messages.js';
import { traefikSay } from './messages.js';
import {
  ProxyError,
  type ProxyCheck,
  type ProxyContext,
  type ProxyDetection,
  type ProxyHostContext,
  type ProxyInstallOption,
  type ProxyInstallRequest,
  type ProxyProvider,
  type ProxyRoute,
  type ProxyRouteSet,
  type RouteProbe,
} from '../types.js';
import {
  configFileArgument,
  DEFAULT_STATIC_FILES,
  interpretTraefikCluster,
  interpretTraefikContainer,
  type InspectedContainer,
} from './detect.js';
import {
  CA_CONFIGMAP,
  defaultDynamicDirectory,
  MANAGED_CONTAINER,
  MANAGED_PROJECT,
  MANAGED_RESOLVER,
  proxyRoot,
  renderHelmChartConfig,
  renderManagedCompose,
  TRAEFIK_IMAGE,
} from './install.js';
import {
  ingressNames,
  REDIRECT_MIDDLEWARE,
  REMOTE_NAMESPACE,
  renderTraefikRemoteIngresses,
  renderTraefikFile,
  renderTraefikIngresses,
  serializeKubeObjects,
  traefikFileName,
} from './render.js';

function fail(step: string, message: string): never {
  throw new ProxyError(message, 'traefik', step);
}

const ensureDirectory = (ctx: ProxyHostContext, directory: string) =>
  ensureDirectoryAs(ctx, directory, 'traefik');
const writeFile = (ctx: ProxyHostContext, path: string, content: string) =>
  writeFileAs(ctx, path, content, 'traefik');
const removeFile = (ctx: ProxyHostContext, path: string) => removeFileAs(ctx, path, 'traefik');

/**
 * Traefik, driven through its own providers: a watched folder (`file` mode) or
 * Ingress objects (`kubernetes` mode). See `model.ts` for the choice,
 * `render.ts` for what is placed, `install.ts` for what is installed.
 */

const SHORT_MS = 30_000;
const INSTALL_MS = 10 * 60_000;

/** The same convention as the K3s driver: K3s's kubeconfig if there is no other. */
const KUBECONFIG_SETUP =
  'if [ -z "${KUBECONFIG:-}" ] && [ -r /etc/rancher/k3s/k3s.yaml ]; ' +
  'then KUBECONFIG=/etc/rancher/k3s/k3s.yaml; export KUBECONFIG; fi';

function kubectl(args: string): string {
  return `${KUBECONFIG_SETUP}\nkubectl ${args}`;
}

/** `kubectl apply -f -`, the manifest on stdin: nothing lingers on the disk. */
async function kubectlApply(ctx: ProxyHostContext, manifest: string, step: string): Promise<void> {
  const result = await execPipe(ctx.sshSession, kubectl('apply -f -'), {
    stdin: Readable.from([Buffer.from(manifest, 'utf8')]),
    timeout: SHORT_MS * 2,
  });
  if (result.code !== 0)
    fail(step, `kubectl apply : ${firstLine(result.stderr) ?? `code ${result.code}`}`);
}

// ─── the provider ────────────────────────────────────────────────────────────

export class TraefikProvider implements ProxyProvider {
  readonly kind = 'traefik' as const;

  parseConfig(config: unknown): TraefikConfig {
    return traefikConfigSchema.parse(config);
  }

  publishAddress(config: unknown): string | null {
    const parsed = this.parseConfig(config);
    if (parsed.mode !== 'file') return null;
    return /^127\.|^localhost$|^::1$/.test(parsed.upstreamHost) ? parsed.upstreamHost : null;
  }

  private directory(ctx: ProxyHostContext, config: TraefikFileConfig): string {
    return config.directory ?? defaultDynamicDirectory(ctx.target.rootPath);
  }

  // ─── detection ──────────────────────────────────────────────────────────────

  async detect(ctx: ProxyHostContext, onLog: LogSink): Promise<ProxyDetection[]> {
    const say = traefikSay(ctx.language);
    const found: ProxyDetection[] = [];

    // A Traefik in a container — the most common case.
    const listed = await exec(
      ctx.sshSession,
      "command -v docker >/dev/null 2>&1 && docker ps --format '{{.ID}}|{{.Image}}|{{.Names}}' 2>/dev/null || true",
      { timeout: SHORT_MS },
    );
    const containers = listed.stdout
      .split('\n')
      .map((line) => line.trim().split('|'))
      .filter((parts) => parts.length === 3 && /traefik/i.test(`${parts[1]} ${parts[2]}`));
    for (const [id] of containers) {
      const inspected = await exec(ctx.sshSession, `docker inspect ${shellQuote(id!)}`, {
        timeout: SHORT_MS,
      });
      const container = (JSON.parse(inspected.stdout || '[]') as InspectedContainer[])[0];
      if (!container) continue;
      const files = configFileArgument(container.Args ?? [])
        ? [configFileArgument(container.Args ?? [])!]
        : DEFAULT_STATIC_FILES;
      const read = await exec(
        ctx.sshSession,
        `docker exec ${shellQuote(id!)} sh -c ${shellQuote(files.map((file) => `cat ${shellQuote(file)} 2>/dev/null`).join(' || '))} || true`,
        { timeout: SHORT_MS },
      );
      const finding = interpretTraefikContainer(
        container,
        read.stdout.trim() || null,
        ctx.language,
      );
      onLog(say('detect.container', { name: container.Name ?? id!, summary: finding.summary }));
      found.push({
        kind: 'traefik',
        config: finding.config,
        summary: finding.summary,
        warnings: finding.warnings,
      });
    }

    // A Traefik installed as a binary, outside a container. The processes of a
    // container or a pod are visible from the machine too: their cgroup gives them
    // away, they were (or will be) seen through their own path.
    const processes = await exec(
      ctx.sshSession,
      [
        'for pid in $(pgrep -x traefik 2>/dev/null); do',
        // kubepods (cgroup v1), /k8s.io/ (K3s's containerd), docker, libpod, or a
        // 64-hex-character container identifier.
        "  grep -qE 'kubepods|k8s\\.io|docker|containerd|libpod|[0-9a-f]{64}' /proc/$pid/cgroup 2>/dev/null && continue",
        "  tr '\\0' ' ' < /proc/$pid/cmdline; echo",
        'done',
      ].join('\n'),
      { timeout: SHORT_MS },
    );
    for (const line of processes.stdout.split('\n').filter((entry) => entry.trim())) {
      const args = line.trim().split(/\s+/).slice(1);
      const file = configFileArgument(args) ?? '/etc/traefik/traefik.yml';
      const read = await exec(ctx.sshSession, `cat ${shellQuote(file)} 2>/dev/null || true`, {
        timeout: SHORT_MS,
      });
      const finding = interpretTraefikContainer(
        {
          Name: say('detect.binary'),
          Args: args,
          HostConfig: { NetworkMode: 'host' },
          // Outside a container, a Traefik path is a path of the machine.
          Mounts: [{ Source: '/', Destination: '/' }],
        },
        read.stdout.trim() || null,
        ctx.language,
      );
      onLog(say('detect.process', { summary: finding.summary }));
      found.push({
        kind: 'traefik',
        config: finding.config,
        summary: finding.summary,
        warnings: finding.warnings,
      });
    }

    // The Traefik of a Kubernetes cluster — the one K3s ships.
    const classes = await exec(
      ctx.sshSession,
      kubectl('get ingressclass -o json 2>/dev/null || true'),
      {
        timeout: SHORT_MS,
      },
    );
    const traefikClasses = parseIngressClasses(classes.stdout);
    if (traefikClasses.length > 0) {
      const deployments = await exec(
        ctx.sshSession,
        kubectl('get deploy -A -l app.kubernetes.io/name=traefik -o json 2>/dev/null || true'),
        { timeout: SHORT_MS },
      );
      const finding = interpretTraefikCluster(
        traefikClasses,
        parseTraefikDeployment(deployments.stdout),
        ctx.language,
      );
      onLog(say('detect.cluster', { summary: finding.summary }));
      found.push({
        kind: 'traefik',
        config: finding.config,
        summary: finding.summary,
        warnings: finding.warnings,
      });
    }

    if (found.length === 0) onLog(say('detect.none', { proxy: 'Traefik' }));
    return found;
  }

  // ─── installation ───────────────────────────────────────────────────────────

  async installOptions(ctx: ProxyHostContext): Promise<ProxyInstallOption[]> {
    const say = traefikSay(ctx.language);
    const probe = await exec(
      ctx.sshSession,
      [
        'if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then echo docker=1; else echo docker=0; fi',
        // Ports 80 and 443: taken by someone else, they prevent everything.
        "busy=$( (ss -ltnH 2>/dev/null || netstat -ltn 2>/dev/null) | awk '{print $4}' | grep -E ':(80|443)$' | sed 's/.*://' | sort -u | tr '\\n' ' ')",
        'echo "busy=$busy"',
        `docker ps -a --filter name=^${MANAGED_CONTAINER}$ --format '{{.Names}}' 2>/dev/null | sed 's/^/managed=/'`,
        kubectl("get ingressclass traefik -o name 2>/dev/null | sed 's/^/class=/'"),
        kubectl(
          `get helmchartconfig traefik -n kube-system -o jsonpath='{.metadata.annotations.pupitre\\.io/managed-by}' 2>/dev/null | sed 's/^/helm=/'; ` +
            "kubectl get helmchartconfig traefik -n kube-system -o name 2>/dev/null | sed 's/^/helmexists=/'",
        ),
      ].join('\n'),
      { timeout: SHORT_MS },
    );
    const value = (key: string) =>
      probe.stdout
        .split('\n')
        .find((line) => line.startsWith(`${key}=`))
        ?.slice(key.length + 1)
        .trim() ?? null;

    const options: ProxyInstallOption[] = [];
    const busy = (value('busy') ?? '').split(' ').filter(Boolean);
    if (value('class')) {
      const foreign = value('helmexists') && value('helm') !== 'pupitre';
      options.push({
        kind: 'traefik',
        key: 'kubernetes',
        title: say('option.k3s.title'),
        acmeServers: ['production', 'staging', 'custom'],
        available: !foreign,
        detail: foreign ? say('option.k3s.foreign') : say('option.k3s.detail'),
      });
    }
    const docker = value('docker') === '1';
    const managed = value('managed') === MANAGED_CONTAINER;
    options.push({
      kind: 'traefik',
      key: 'container',
      title: say('option.container.title'),
      acmeServers: ['production', 'staging', 'custom'],
      available: docker && (managed || busy.length === 0),
      detail: !docker
        ? say('option.container.noDocker')
        : !managed && busy.length > 0
          ? say('install.portBusy', { ports: listOf(busy, ctx.language) })
          : say('option.container.detail', { image: TRAEFIK_IMAGE }),
    });
    return options;
  }

  async install(
    ctx: ProxyHostContext,
    request: ProxyInstallRequest,
    onLog: LogSink,
  ): Promise<TraefikConfig> {
    const options = await this.installOptions(ctx);
    const option = options.find((candidate) => candidate.key === request.option);
    if (!option) {
      fail('install', traefikSay(ctx.language)('install.unavailable', { option: request.option }));
    }
    if (!option.available) fail('install', option.detail);
    return request.option === 'kubernetes'
      ? this.installInCluster(ctx, request, onLog)
      : this.installContainer(ctx, request, onLog);
  }

  private async installContainer(
    ctx: ProxyHostContext,
    request: ProxyInstallRequest,
    onLog: LogSink,
  ): Promise<TraefikFileConfig> {
    const say = traefikSay(ctx.language);
    const root = proxyRoot(ctx.target.rootPath);
    await ensureDirectory(ctx, `${root}/dynamic`);
    if (request.acme.caCertificate) {
      await writeFile(ctx, `${root}/acme-ca.pem`, request.acme.caCertificate);
    }
    await writeFile(
      ctx,
      `${root}/compose.yml`,
      renderManagedCompose(ctx.target.rootPath, request.acme),
    );
    onLog(`docker compose up — ${TRAEFIK_IMAGE}`);
    const up = await exec(
      ctx.sshSession,
      `cd ${shellQuote(root)} && docker compose -p ${MANAGED_PROJECT} up -d --pull missing 2>&1`,
      { timeout: INSTALL_MS },
    );
    if (up.code !== 0)
      fail(
        'install',
        say('install.compose', { detail: firstLine(up.stdout) ?? `code ${up.code}` }),
      );

    // Ready when the liveness probe says so, not when the container has started.
    let health = '';
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const state = await exec(
        ctx.sshSession,
        `docker inspect -f '{{.State.Health.Status}}' ${MANAGED_CONTAINER} 2>/dev/null || true`,
        { timeout: SHORT_MS },
      );
      health = state.stdout.trim();
      if (health === 'healthy') break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    if (health !== 'healthy') {
      fail(
        'install',
        say('install.notHealthy', { proxy: 'Traefik', state: health || say('state.unknown') }),
      );
    }
    onLog(say('install.answers'));

    for (const port of [80, 443]) {
      await ufwAllowPort(ctx, port, `${UFW_MARKER}:proxy`, onLog);
    }
    return {
      mode: 'file',
      directory: null,
      upstreamHost: '127.0.0.1',
      container: MANAGED_CONTAINER,
      image: TRAEFIK_IMAGE,
      entryPoints: { http: 'web', https: 'websecure' },
      certResolver: MANAGED_RESOLVER,
      acme: request.acme,
    };
  }

  private async installInCluster(
    ctx: ProxyHostContext,
    request: ProxyInstallRequest,
    onLog: LogSink,
  ): Promise<TraefikKubernetesConfig> {
    const say = traefikSay(ctx.language);
    const namespace = 'kube-system';
    onLog(say('install.helm'));
    await kubectlApply(ctx, renderHelmChartConfig(namespace, request.acme), 'install');

    // K3s's Helm controller restarts Traefik with these values; we wait for the
    // deployment to carry the resolver, then for it to be ready.
    let configured = false;
    for (let attempt = 0; attempt < 60 && !configured; attempt += 1) {
      const args = await exec(
        ctx.sshSession,
        kubectl(
          `-n ${namespace} get deploy traefik -o jsonpath='{.spec.template.spec.containers[0].args}' 2>/dev/null || true`,
        ),
        { timeout: SHORT_MS },
      );
      configured = args.stdout.includes(`certificatesresolvers.${MANAGED_RESOLVER}.acme`);
      if (!configured) await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    if (!configured) fail('install', say('install.notReconfigured'));
    const rollout = await exec(
      ctx.sshSession,
      kubectl(`-n ${namespace} rollout status deploy/traefik --timeout=300s`),
      { timeout: INSTALL_MS },
    );
    if (rollout.code !== 0)
      fail(
        'install',
        say('install.noRestart', {
          detail: firstLine(rollout.stderr) ?? firstLine(rollout.stdout) ?? '',
        }),
      );
    // The pod is ready before the cluster's load balancer serves it on ports 80 and
    // 443: we wait for it to really answer, from the machine.
    let answering = false;
    for (let attempt = 0; attempt < 30 && !answering; attempt += 1) {
      answering = (await httpCode(ctx, 'http://127.0.0.1/')) !== 0;
      if (!answering) await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    if (!answering) fail('install', say('install.port80Silent'));
    onLog(say('install.restarted'));
    return {
      mode: 'kubernetes',
      ingressClass: 'traefik',
      namespace,
      entryPoints: { http: 'web', https: 'websecure' },
      certResolver: MANAGED_RESOLVER,
      acme: request.acme,
    };
  }

  async uninstall(ctx: ProxyContext, onLog: LogSink): Promise<void> {
    const say = traefikSay(ctx.language);
    const config = this.parseConfig(ctx.config);
    if (!config.acme) {
      onLog(say('uninstall.foreign', { proxy: 'Traefik' }));
      return;
    }
    if (config.mode === 'kubernetes') {
      const annotation = await exec(
        ctx.sshSession,
        kubectl(
          `get helmchartconfig traefik -n ${config.namespace} -o jsonpath='{.metadata.annotations.pupitre\\.io/managed-by}' 2>/dev/null || true`,
        ),
        { timeout: SHORT_MS },
      );
      if (annotation.stdout.trim() === 'pupitre') {
        await exec(
          ctx.sshSession,
          kubectl(
            `-n ${config.namespace} delete helmchartconfig traefik --ignore-not-found; ` +
              `kubectl -n ${config.namespace} delete configmap ${CA_CONFIGMAP} --ignore-not-found`,
          ),
          { timeout: SHORT_MS * 2 },
        );
        onLog(say('uninstall.settingsRemoved'));
      }
      // The namespace of routes to other machines is Pupitre's: empty of routes, it
      // goes with the rest — and with it, the shared middleware.
      const routesNamespace = await exec(
        ctx.sshSession,
        kubectl(
          `get namespace ${REMOTE_NAMESPACE} -o jsonpath='{.metadata.labels.app\\.kubernetes\\.io/managed-by}' 2>/dev/null; ` +
            `echo; kubectl -n ${REMOTE_NAMESPACE} get ingress -o name 2>/dev/null | wc -l`,
        ),
        { timeout: SHORT_MS },
      );
      const [owner, ingresses] = routesNamespace.stdout.split('\n').map((line) => line.trim());
      if (owner === 'pupitre' && Number(ingresses) === 0) {
        await exec(
          ctx.sshSession,
          kubectl(`delete namespace ${REMOTE_NAMESPACE} --ignore-not-found --wait=false`),
          { timeout: SHORT_MS },
        );
        onLog(say('uninstall.namespaceRemoved', { namespace: REMOTE_NAMESPACE }));
      }
      return;
    }
    const root = proxyRoot(ctx.target.rootPath);
    const down = await exec(
      ctx.sshSession,
      `cd ${shellQuote(root)} 2>/dev/null && docker compose -p ${MANAGED_PROJECT} down -v 2>&1 || docker rm -f ${MANAGED_CONTAINER} 2>&1 || true`,
      { timeout: INSTALL_MS },
    );
    onLog(firstLine(down.stdout) ?? say('uninstall.stopped'));
    await exec(ctx.sshSession, `rm -rf ${shellQuote(root)}`, { timeout: SHORT_MS });
    onLog(say('uninstall.removed'));
  }

  // ─── "Test" ─────────────────────────────────────────────────────────────────

  async check(ctx: ProxyContext, onLog: LogSink): Promise<ProxyCheck> {
    const say = traefikSay(ctx.language);
    const config = this.parseConfig(ctx.config);
    const checks: ProxyCheck['checks'] = [];
    const add = (key: string, label: string, ok: boolean, detail: string | null) => {
      checks.push({ key, label, ok, detail });
      onLog(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
    };

    const http = await httpCode(ctx, 'http://127.0.0.1/');
    const answer = (code: number) =>
      code !== 0 ? say('check.answers', { code }) : say('check.silent');
    add('http', 'Port 80', http !== 0, answer(http));
    if (config.entryPoints.https) {
      const https = await httpCode(ctx, 'https://127.0.0.1/');
      add('https', 'Port 443', https !== 0, answer(https));
    }

    if (config.mode === 'file') {
      const directory = this.directory(ctx, config);
      const writable = await exec(
        ctx.sshSession,
        `test -d ${shellQuote(directory)} && (test -w ${shellQuote(directory)} && echo direct || echo sudo) || echo absent`,
        { timeout: SHORT_MS },
      );
      const access = writable.stdout.trim();
      add(
        'directory',
        say('check.directory'),
        access !== 'absent',
        access === 'absent'
          ? say('check.directory.missing', { directory })
          : access === 'sudo'
            ? say('check.directory.sudo', { directory })
            : directory,
      );
      if (access !== 'absent' && http !== 0) {
        // The proof that Traefik reads this folder: a test route toward a closed port.
        // Read, it gives 502; ignored, 404.
        const host = `pupitre-check-${randomBytes(4).toString('hex')}.invalid`;
        const file = `${directory}/pupitre-check.yml`;
        await writeFile(
          ctx,
          file,
          `# Route d'essai de Pupitre, retirée aussitôt.\nhttp:\n  routers:\n    pupitre-check:\n      rule: Host(\`${host}\`)\n      entryPoints: [${config.entryPoints.http}]\n      service: pupitre-check\n  services:\n    pupitre-check:\n      loadBalancer:\n        servers:\n          - url: http://127.0.0.1:9\n`,
        );
        let code = 0;
        for (let attempt = 0; attempt < 8; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          code = await httpCode(ctx, 'http://127.0.0.1/', host);
          if (code !== 404) break;
        }
        await removeFile(ctx, file);
        add(
          'reload',
          say('check.reload'),
          code === 502,
          code === 502
            ? say('check.reload.ok')
            : say('check.reload.ignored', { code: code || say('noAnswer') }),
        );
      }
      if (config.container) {
        const running = await exec(
          ctx.sshSession,
          `docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' ${shellQuote(config.container)} 2>/dev/null || true`,
          { timeout: SHORT_MS },
        );
        const state = running.stdout.trim();
        add(
          'container',
          say('check.container', { name: config.container }),
          state.startsWith('running'),
          state || say('check.notFound'),
        );
      }
    } else {
      const classes = await exec(
        ctx.sshSession,
        kubectl('get ingressclass -o json 2>/dev/null || true'),
        {
          timeout: SHORT_MS,
        },
      );
      const present = parseIngressClasses(classes.stdout).includes(config.ingressClass);
      add(
        'ingressclass',
        `IngressClass ${config.ingressClass}`,
        present,
        present ? null : say('check.ingressClass.missing'),
      );
      const ready = await exec(
        ctx.sshSession,
        kubectl(
          `-n ${config.namespace} get deploy -l app.kubernetes.io/name=traefik -o jsonpath='{.items[0].status.readyReplicas}/{.items[0].spec.replicas}' 2>/dev/null || true`,
        ),
        { timeout: SHORT_MS },
      );
      const [readyCount, wanted] = ready.stdout.trim().split('/');
      add(
        'deployment',
        say('check.ready'),
        Boolean(readyCount) && readyCount === wanted,
        ready.stdout.trim() || say('check.notFound'),
      );
      if (config.certResolver) {
        const args = await exec(
          ctx.sshSession,
          kubectl(
            `-n ${config.namespace} get deploy -l app.kubernetes.io/name=traefik -o jsonpath='{.items[0].spec.template.spec.containers[0].args}' 2>/dev/null || true`,
          ),
          { timeout: SHORT_MS },
        );
        const known = args.stdout.includes(`certificatesresolvers.${config.certResolver}.`);
        add(
          'resolver',
          say('check.resolver', { name: config.certResolver }),
          known,
          known ? null : say('check.resolver.unknown'),
        );
      }
    }
    return { ok: checks.every((check) => check.ok), checks };
  }

  // ─── routes ─────────────────────────────────────────────────────────────────

  async apply(ctx: ProxyContext, set: ProxyRouteSet, onLog: LogSink): Promise<void> {
    const say = traefikSay(ctx.language);
    const config = this.parseConfig(ctx.config);
    if (set.routes.length > 0 && !set.upstream) {
      fail('apply', say('apply.noUpstream'));
    }
    // The same application can run on several of the machines this proxy serves:
    // its objects' name then carries the one it comes from.
    const name = set.scope ? `${set.appSlug}--${set.scope}` : set.appSlug;
    const remote = set.upstream?.kind === 'port' && set.upstream.host ? set.upstream : null;

    if (config.mode === 'file') {
      const directory = this.directory(ctx, config);
      const path = `${directory}/${traefikFileName(name)}`;
      if (set.routes.length === 0) {
        await removeFile(ctx, path);
        onLog(say('apply.removed', { path }));
        return;
      }
      if (set.upstream?.kind !== 'port') {
        fail('apply', say('apply.fileNeedsPort'));
      }
      const host = set.upstream.host ?? config.upstreamHost;
      await ensureDirectory(ctx, directory);
      await writeFile(
        ctx,
        path,
        renderTraefikFile(name, set.routes, `http://${host}:${set.upstream.port}`, config),
      );
      onLog(say('apply.written', { path, upstream: `${host}:${set.upstream.port}` }));
      return;
    }

    const names = ingressNames(name);
    if (set.routes.length === 0) {
      // The namespace follows the upstream: the application's one in the cluster, or
      // the one of routes to the outside — a scope alone says that the machine is not
      // the proxy's, the upstream may have disappeared with the application. Without
      // an upstream, the K3s driver's convention.
      const away = remote !== null || set.scope !== undefined;
      const namespace =
        set.upstream?.kind === 'kubernetes'
          ? set.upstream.namespace
          : away
            ? REMOTE_NAMESPACE
            : `app-${set.appSlug}`;
      const extra = away
        ? `; kubectl -n ${namespace} delete service ${name} --ignore-not-found >/dev/null 2>&1; ` +
          `kubectl -n ${namespace} delete endpointslice ${name}-upstream --ignore-not-found >/dev/null 2>&1`
        : // The redirect middleware belongs to the application's namespace; in the one of
          // outside routes, it is shared and stays.
          `; kubectl -n ${namespace} delete middleware.traefik.io ${REDIRECT_MIDDLEWARE} --ignore-not-found >/dev/null 2>&1`;
      await exec(
        ctx.sshSession,
        kubectl(
          `-n ${namespace} delete ingress ${Object.values(names).join(' ')} --ignore-not-found 2>&1${extra}; true`,
        ),
        { timeout: SHORT_MS },
      );
      onLog(say('apply.removedFromNamespace', { namespace }));
      return;
    }

    let rendered: ReturnType<typeof renderTraefikIngresses>;
    let namespace: string;
    if (set.upstream?.kind === 'kubernetes') {
      rendered = renderTraefikIngresses(name, set.routes, set.upstream, config);
      namespace = set.upstream.namespace;
    } else if (remote) {
      if (!isIPv4(remote.host!)) {
        fail('apply', say('apply.needsIpv4', { host: remote.host! }));
      }
      rendered = renderTraefikRemoteIngresses(
        name,
        set.routes,
        { host: remote.host!, port: remote.port },
        config,
      );
      namespace = REMOTE_NAMESPACE;
    } else {
      fail('apply', say('apply.clusterOnly'));
    }
    await kubectlApply(ctx, serializeKubeObjects(rendered.objects), 'apply');
    if (rendered.stale.length > 0) {
      await exec(
        ctx.sshSession,
        kubectl(`-n ${namespace} delete ingress ${rendered.stale.join(' ')} --ignore-not-found`),
        { timeout: SHORT_MS },
      );
    }
    onLog(
      say('apply.ingresses', {
        namespace,
        hostnames: set.routes.map((route) => route.hostname).join(', '),
      }) + (remote ? ` → ${remote.host}:${remote.port}` : ''),
    );
  }

  async probe(ctx: ProxyContext, route: ProxyRoute, path: string): Promise<RouteProbe> {
    return probeRoute(ctx, route, path, TRAEFIK_PROBE);
  }
}

// ─── lectures Kubernetes ─────────────────────────────────────────────────────

export function parseIngressClasses(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as {
      items?: Array<{ metadata?: { name?: string }; spec?: { controller?: string } }>;
    };
    return (parsed.items ?? [])
      .filter((item) => item.spec?.controller === 'traefik.io/ingress-controller')
      .map((item) => item.metadata?.name ?? '')
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function parseTraefikDeployment(json: string): { namespace: string; args: string[] } | null {
  try {
    const parsed = JSON.parse(json) as {
      items?: Array<{
        metadata?: { namespace?: string };
        spec?: { template?: { spec?: { containers?: Array<{ args?: string[] }> } } };
      }>;
    };
    const item = parsed.items?.[0];
    if (!item) return null;
    return {
      namespace: item.metadata?.namespace ?? 'kube-system',
      args: item.spec?.template?.spec?.containers?.[0]?.args ?? [],
    };
  } catch {
    return null;
  }
}
