import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { ufwAllowPort, UFW_MARKER } from '../../drivers/ufw.js';
import type { LogSink } from '../../drivers/types.js';
import { exec, execPipe, upload } from '../../ssh/client.js';
import {
  traefikConfigSchema,
  type TraefikConfig,
  type TraefikFileConfig,
  type TraefikKubernetesConfig,
} from '../model.js';
import { probeRoute } from '../probe.js';
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
  renderTraefikFile,
  renderTraefikIngresses,
  serializeKubeObjects,
  traefikFileName,
} from './render.js';

/**
 * Traefik, piloté par ses propres fournisseurs : un dossier surveillé (mode
 * `file`) ou des objets Ingress (mode `kubernetes`). Voir `model.ts` pour le
 * choix, `render.ts` pour ce qui est déposé, `install.ts` pour ce qui est
 * installé.
 */

const SHORT_MS = 30_000;
const INSTALL_MS = 10 * 60_000;

/** Même convention que le driver K3s : le kubeconfig de K3s s'il n'y en a pas d'autre. */
const KUBECONFIG_SETUP =
  'if [ -z "${KUBECONFIG:-}" ] && [ -r /etc/rancher/k3s/k3s.yaml ]; ' +
  'then KUBECONFIG=/etc/rancher/k3s/k3s.yaml; export KUBECONFIG; fi';

function kubectl(args: string): string {
  return `${KUBECONFIG_SETUP}\nkubectl ${args}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function firstLine(text: string): string | null {
  return (
    text
      .trim()
      .split('\n')
      .find((line) => line.trim().length > 0)
      ?.trim() ?? null
  );
}

function fail(step: string, message: string): never {
  throw new ProxyError(message, 'traefik', step);
}

// ─── fichiers sur la machine ─────────────────────────────────────────────────

/** Crée un dossier ; par sudo, en le rendant au compte de déploiement, si besoin. */
async function ensureDirectory(ctx: ProxyHostContext, directory: string): Promise<void> {
  const direct = await exec(ctx.sshSession, `mkdir -p ${shellQuote(directory)}`, {
    timeout: SHORT_MS,
  });
  if (direct.code === 0) return;
  const identity = await exec(ctx.sshSession, 'echo "$(id -u):$(id -g)"', { timeout: SHORT_MS });
  const owner = identity.stdout.trim();
  const elevated = await exec(
    ctx.sshSession,
    `mkdir -p ${shellQuote(directory)} && chown ${owner} ${shellQuote(directory)}`,
    { sudo: true, timeout: SHORT_MS },
  );
  if (elevated.code !== 0) {
    fail(
      'directory',
      `${directory} : ${firstLine(elevated.stderr) ?? firstLine(direct.stderr) ?? 'création impossible'}`,
    );
  }
}

/**
 * Écrit un fichier. Directement d'abord ; un dossier qui appartient à root —
 * celui d'un Traefik installé à la main, typiquement — passe par un fichier
 * temporaire et `sudo install`.
 */
async function writeFile(ctx: ProxyHostContext, path: string, content: string): Promise<void> {
  try {
    await upload(ctx.sshSession, Buffer.from(content, 'utf8'), path);
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/permission denied|eacces/i.test(message)) throw error;
  }
  const temporary = `/tmp/pupitre-${randomBytes(6).toString('hex')}`;
  await upload(ctx.sshSession, Buffer.from(content, 'utf8'), temporary);
  const moved = await exec(
    ctx.sshSession,
    `install -m 0644 ${shellQuote(temporary)} ${shellQuote(path)}; code=$?; rm -f ${shellQuote(temporary)}; exit $code`,
    { sudo: true, timeout: SHORT_MS },
  );
  if (moved.code !== 0) fail('write', `${path} : ${firstLine(moved.stderr) ?? 'écriture refusée'}`);
}

async function removeFile(ctx: ProxyHostContext, path: string): Promise<void> {
  const direct = await exec(ctx.sshSession, `rm -f ${shellQuote(path)}`, { timeout: SHORT_MS });
  if (direct.code === 0) return;
  const elevated = await exec(ctx.sshSession, `rm -f ${shellQuote(path)}`, {
    sudo: true,
    timeout: SHORT_MS,
  });
  if (elevated.code !== 0)
    fail('remove', `${path} : ${firstLine(elevated.stderr) ?? 'suppression refusée'}`);
}

/** `kubectl apply -f -`, le manifeste sur l'entrée standard : rien ne traîne sur le disque. */
async function kubectlApply(ctx: ProxyHostContext, manifest: string, step: string): Promise<void> {
  const result = await execPipe(ctx.sshSession, kubectl('apply -f -'), {
    stdin: Readable.from([Buffer.from(manifest, 'utf8')]),
    timeout: SHORT_MS * 2,
  });
  if (result.code !== 0)
    fail(step, `kubectl apply : ${firstLine(result.stderr) ?? `code ${result.code}`}`);
}

/** Un code HTTP lu sur la machine, `0` quand rien ne répond. */
async function httpCode(ctx: ProxyHostContext, url: string, host?: string): Promise<number> {
  const header = host ? ` -H ${shellQuote(`Host: ${host}`)}` : '';
  const result = await exec(
    ctx.sshSession,
    `curl -s -k -o /dev/null -w '%{http_code}' -m 5${header} ${shellQuote(url)} || true`,
    { timeout: SHORT_MS },
  );
  return Number(result.stdout.trim()) || 0;
}

// ─── le provider ─────────────────────────────────────────────────────────────

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

  // ─── détection ──────────────────────────────────────────────────────────────

  async detect(ctx: ProxyHostContext, onLog: LogSink): Promise<ProxyDetection[]> {
    const found: ProxyDetection[] = [];

    // Un Traefik en conteneur — le cas le plus courant.
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
      const finding = interpretTraefikContainer(container, read.stdout.trim() || null);
      onLog(`conteneur ${container.Name ?? id} : ${finding.summary}`);
      found.push({ config: finding.config, summary: finding.summary, warnings: finding.warnings });
    }

    // Un Traefik installé en binaire, hors conteneur. Les processus d'un
    // conteneur ou d'un pod sont visibles de la machine aussi : leur cgroup les
    // trahit, ils ont été (ou seront) vus par leur propre chemin.
    const processes = await exec(
      ctx.sshSession,
      [
        'for pid in $(pgrep -x traefik 2>/dev/null); do',
        // kubepods (cgroup v1), /k8s.io/ (containerd de K3s), docker, libpod,
        // ou un identifiant de conteneur de 64 caractères hexadécimaux.
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
          Name: 'traefik (binaire)',
          Args: args,
          HostConfig: { NetworkMode: 'host' },
          // Hors conteneur, un chemin de Traefik est un chemin de la machine.
          Mounts: [{ Source: '/', Destination: '/' }],
        },
        read.stdout.trim() || null,
      );
      onLog(`processus : ${finding.summary}`);
      found.push({ config: finding.config, summary: finding.summary, warnings: finding.warnings });
    }

    // Le Traefik d'un cluster Kubernetes — celui que K3s livre.
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
      );
      onLog(`cluster : ${finding.summary}`);
      found.push({ config: finding.config, summary: finding.summary, warnings: finding.warnings });
    }

    if (found.length === 0) onLog('aucun Traefik sur cette machine');
    return found;
  }

  // ─── installation ───────────────────────────────────────────────────────────

  async installOptions(ctx: ProxyHostContext): Promise<ProxyInstallOption[]> {
    const probe = await exec(
      ctx.sshSession,
      [
        'if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then echo docker=1; else echo docker=0; fi',
        // Les ports 80 et 443 : pris par quelqu'un d'autre, ils empêchent tout.
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
        key: 'kubernetes',
        available: !foreign,
        detail: foreign
          ? 'une HelmChartConfig « traefik » existe déjà dans kube-system : Pupitre ne l’écrase pas'
          : 'régler le Traefik livré avec K3s : certificats Let’s Encrypt et volume pour les garder',
      });
    }
    const docker = value('docker') === '1';
    const managed = value('managed') === MANAGED_CONTAINER;
    options.push({
      key: 'container',
      available: docker && (managed || busy.length === 0),
      detail: !docker
        ? 'Docker est absent ou inaccessible sur cette machine'
        : !managed && busy.length > 0
          ? `le port ${busy.join(' et ')} est déjà utilisé : un autre serveur web ou proxy tourne ici`
          : `installer ${TRAEFIK_IMAGE} en conteneur, sur les ports 80 et 443`,
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
    if (!option) fail('install', `installation « ${request.option} » impossible sur cette machine`);
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
      fail('install', `docker compose up : ${firstLine(up.stdout) ?? `code ${up.code}`}`);

    // Prêt quand la sonde de vie le dit, pas quand le conteneur a démarré.
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
    if (health !== 'healthy')
      fail('install', `Traefik ne répond pas après son démarrage (état : ${health || 'inconnu'})`);
    onLog('Traefik répond');

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
    const namespace = 'kube-system';
    onLog('HelmChartConfig traefik — résolveur ACME et volume des certificats');
    await kubectlApply(ctx, renderHelmChartConfig(namespace, request.acme), 'install');

    // Le contrôleur Helm de K3s relance Traefik avec ces valeurs ; on attend
    // que le déploiement porte le résolveur, puis qu'il soit prêt.
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
    if (!configured) fail('install', "K3s n'a pas reconfiguré Traefik dans les temps");
    const rollout = await exec(
      ctx.sshSession,
      kubectl(`-n ${namespace} rollout status deploy/traefik --timeout=300s`),
      { timeout: INSTALL_MS },
    );
    if (rollout.code !== 0)
      fail(
        'install',
        `Traefik ne redémarre pas : ${firstLine(rollout.stderr) ?? firstLine(rollout.stdout) ?? ''}`,
      );
    // Le pod est prêt avant que l'équilibreur du cluster ne le serve sur les
    // ports 80 et 443 : on attend qu'il réponde vraiment, de la machine.
    let answering = false;
    for (let attempt = 0; attempt < 30 && !answering; attempt += 1) {
      answering = (await httpCode(ctx, 'http://127.0.0.1/')) !== 0;
      if (!answering) await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    if (!answering)
      fail('install', 'Traefik est prêt, mais rien ne répond sur le port 80 de la machine');
    onLog('Traefik redémarré avec le résolveur de certificats');
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
    const config = this.parseConfig(ctx.config);
    if (!config.acme) {
      onLog("Traefik n'a pas été installé par Pupitre : il reste en place");
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
        onLog('réglages de Traefik retirés : K3s revient à sa configuration par défaut');
      }
      return;
    }
    const root = proxyRoot(ctx.target.rootPath);
    const down = await exec(
      ctx.sshSession,
      `cd ${shellQuote(root)} 2>/dev/null && docker compose -p ${MANAGED_PROJECT} down -v 2>&1 || docker rm -f ${MANAGED_CONTAINER} 2>&1 || true`,
      { timeout: INSTALL_MS },
    );
    onLog(firstLine(down.stdout) ?? 'conteneur arrêté');
    await exec(ctx.sshSession, `rm -rf ${shellQuote(root)}`, { timeout: SHORT_MS });
    onLog('Traefik retiré de la machine');
  }

  // ─── « Tester » ─────────────────────────────────────────────────────────────

  async check(ctx: ProxyContext, onLog: LogSink): Promise<ProxyCheck> {
    const config = this.parseConfig(ctx.config);
    const checks: ProxyCheck['checks'] = [];
    const add = (key: string, label: string, ok: boolean, detail: string | null) => {
      checks.push({ key, label, ok, detail });
      onLog(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
    };

    const http = await httpCode(ctx, 'http://127.0.0.1/');
    add('http', 'Port 80', http !== 0, http !== 0 ? `répond (${http})` : 'rien n’écoute');
    if (config.entryPoints.https) {
      const https = await httpCode(ctx, 'https://127.0.0.1/');
      add('https', 'Port 443', https !== 0, https !== 0 ? `répond (${https})` : 'rien n’écoute');
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
        'Dossier des routes',
        access !== 'absent',
        access === 'absent'
          ? `${directory} n’existe pas`
          : `${directory}${access === 'sudo' ? ' (écrit par sudo)' : ''}`,
      );
      if (access !== 'absent' && http !== 0) {
        // La preuve que Traefik lit ce dossier : une route d'essai vers un port
        // fermé. Lue, elle donne 502 ; ignorée, 404.
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
          'Traefik lit ce dossier',
          code === 502,
          code === 502
            ? 'une route d’essai y a été prise en compte'
            : `route d’essai ignorée (${code || 'pas de réponse'})`,
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
          `Conteneur ${config.container}`,
          state.startsWith('running'),
          state || 'introuvable',
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
        present ? null : 'absente du cluster',
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
        'Traefik prêt',
        Boolean(readyCount) && readyCount === wanted,
        ready.stdout.trim() || 'introuvable',
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
          `Résolveur « ${config.certResolver} »`,
          known,
          known ? null : 'inconnu de ce Traefik',
        );
      }
    }
    return { ok: checks.every((check) => check.ok), checks };
  }

  // ─── les routes ─────────────────────────────────────────────────────────────

  async apply(ctx: ProxyContext, set: ProxyRouteSet, onLog: LogSink): Promise<void> {
    const config = this.parseConfig(ctx.config);
    if (set.routes.length > 0 && !set.upstream) {
      fail('apply', "l'application n'expose rien que le proxy puisse joindre");
    }

    if (config.mode === 'file') {
      const directory = this.directory(ctx, config);
      const path = `${directory}/${traefikFileName(set.appSlug)}`;
      if (set.routes.length === 0) {
        await removeFile(ctx, path);
        onLog(`routes retirées : ${path}`);
        return;
      }
      if (set.upstream?.kind !== 'port') {
        fail(
          'apply',
          "ce Traefik lit des fichiers : il ne joint qu'une application publiée sur un port de la machine",
        );
      }
      await ensureDirectory(ctx, directory);
      await writeFile(
        ctx,
        path,
        renderTraefikFile(
          set.appSlug,
          set.routes,
          `http://${config.upstreamHost}:${set.upstream.port}`,
          config,
        ),
      );
      onLog(`routes écrites : ${path} → ${config.upstreamHost}:${set.upstream.port}`);
      return;
    }

    const names = ingressNames(set.appSlug);
    if (set.routes.length === 0) {
      // Sans amont, on ne sait pas le namespace : celui du driver K3s, par convention.
      const namespace =
        set.upstream?.kind === 'kubernetes' ? set.upstream.namespace : `app-${set.appSlug}`;
      await exec(
        ctx.sshSession,
        kubectl(
          `-n ${namespace} delete ingress ${Object.values(names).join(' ')} --ignore-not-found 2>&1; ` +
            `kubectl -n ${namespace} delete middleware.traefik.io ${REDIRECT_MIDDLEWARE} --ignore-not-found >/dev/null 2>&1 || true`,
        ),
        { timeout: SHORT_MS },
      );
      onLog(`routes retirées du namespace ${namespace}`);
      return;
    }
    if (set.upstream?.kind !== 'kubernetes') {
      fail(
        'apply',
        'ce Traefik vit dans le cluster : il ne joint que des applications déployées dans ce cluster',
      );
    }
    const rendered = renderTraefikIngresses(set.appSlug, set.routes, set.upstream, config);
    await kubectlApply(ctx, serializeKubeObjects(rendered.objects), 'apply');
    if (rendered.stale.length > 0) {
      await exec(
        ctx.sshSession,
        kubectl(
          `-n ${set.upstream.namespace} delete ingress ${rendered.stale.join(' ')} --ignore-not-found`,
        ),
        { timeout: SHORT_MS },
      );
    }
    onLog(
      `Ingress appliqués dans ${set.upstream.namespace} : ${set.routes.map((route) => route.hostname).join(', ')}`,
    );
  }

  async probe(ctx: ProxyContext, route: ProxyRoute, path: string): Promise<RouteProbe> {
    return probeRoute(ctx, route, path);
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
