import { randomBytes } from 'node:crypto';
import { ufwAllowPort, UFW_MARKER } from '../../drivers/ufw.js';
import type { LogSink } from '../../drivers/types.js';
import { exec } from '../../ssh/client.js';
import { ensureDirectory, httpCode, removeFile, writeFile } from '../host.js';
import { firstLine, shellQuote } from '../../shell.js';
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
  BUNKERWEB_ACME_SERVERS,
  BUNKERWEB_PROBE,
  bunkerwebConfigSchema,
  type BunkerWebConfig,
} from './config.js';
import {
  BUNKERWEB_API_PORT,
  BUNKERWEB_CONTAINER,
  BUNKERWEB_IMAGE,
  BUNKERWEB_PROJECT,
  bunkerwebRoot,
  parseRegistry,
  planServices,
  PROBE_SECRET_PLACEHOLDER,
  probeHeaderFile,
  PROBE_HEADER,
  registryFileName,
  renderBunkerwebCompose,
  serviceVariables,
} from './render.js';

/**
 * BunkerWeb, piloté par son API REST — appelée **depuis sa machine**, par SSH.
 *
 * Le jeton de l'API ne quitte jamais cette machine : chaque appel le lit dans
 * l'environnement du conteneur, l'écrit dans un fichier temporaire lisible du
 * seul compte, et `curl` le lit là (`-H @fichier`) — ni en argument d'un
 * processus, ni dans une sortie, ni dans la base de Pupitre.
 */

const SHORT_MS = 30_000;
const INSTALL_MS = 20 * 60_000;
/** L'image tout-en-un pèse ~2,1 Go ; on demande un peu de marge. */
const IMAGE_DISK_KB = 3 * 1024 * 1024;
/** Mesuré à vide : ~650 Mo. En dessous de 800 Mo disponibles, on prévient. */
const MEMORY_WARNING_KB = 800 * 1024;

function fail(step: string, message: string): never {
  throw new ProxyError(message, 'bunkerweb', step);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Deux poses simultanées sur le même BunkerWeb se marcheraient dessus : son
 * API relit et réécrit la configuration entière à chaque appel. On les met
 * l'une après l'autre, machine par machine.
 */
const queues = new Map<string, Promise<unknown>>();
function serialized<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(run);
  queues.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

// ─── l'API, depuis la machine ────────────────────────────────────────────────

type ApiResponse = { status: number; body: unknown };

/**
 * Un appel à l'API. Le corps — des réglages, jamais un secret — voyage en
 * base64 dans la commande ; l'adresse du conteneur et le jeton sont lus sur
 * place, à chaque fois — un conteneur recréé change d'adresse.
 */
async function api(
  ctx: ProxyHostContext,
  config: BunkerWebConfig,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  /** Un fichier de la machine dont la valeur remplace `PROBE_SECRET_PLACEHOLDER` dans le corps. */
  secretFrom?: string,
): Promise<ApiResponse> {
  const container = shellQuote(config.apiContainer);
  const script = [
    `C=${container}`,
    `IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$C" 2>/dev/null | awk '{print $1}')`,
    `[ -n "$IP" ] || { [ "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$C" 2>/dev/null)" = host ] && IP=127.0.0.1; }`,
    '[ -n "$IP" ] || { echo "PUPITRE_API absent"; exit 0; }',
    'H=$(mktemp) || exit 1',
    'trap \'rm -f "$H"\' EXIT',
    `docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$C" 2>/dev/null | sed -n 's/^API_TOKEN=\\(..*\\)$/Authorization: Bearer \\1/p' | head -n 1 > "$H"`,
    '[ -s "$H" ] || { echo "PUPITRE_API sans-jeton"; exit 0; }',
    (body === undefined
      ? ''
      : `printf '%s' '${Buffer.from(JSON.stringify(body), 'utf8').toString('base64')}' | base64 -d | ` +
        // Le secret des sondes, glissé sur la machine : awk le lit dans son
        // fichier, il n'apparaît dans aucun argument de processus.
        (secretFrom
          ? `awk -v f=${shellQuote(secretFrom)} 'BEGIN { getline s < f; sub(/^[^:]*: */, "", s) } { gsub(/${PROBE_SECRET_PLACEHOLDER}/, s); print }' | `
          : '')) +
      `curl -s -m 30 -X ${method} -H @"$H" -H 'Content-Type: application/json'` +
      (body === undefined ? '' : ' --data-binary @-') +
      ` -w '\\nPUPITRE_HTTP %{http_code}' "http://$IP:${config.apiPort}${path}"`,
  ].join('\n');
  const result = await exec(ctx.sshSession, script, { timeout: SHORT_MS * 2 });
  if (/^PUPITRE_API absent/m.test(result.stdout)) {
    fail('api', `le conteneur ${config.apiContainer} est introuvable ou arrêté`);
  }
  if (/^PUPITRE_API sans-jeton/m.test(result.stdout)) {
    fail(
      'api',
      `le conteneur ${config.apiContainer} n'a pas d'API_TOKEN : Pupitre ne peut pas piloter ce BunkerWeb`,
    );
  }
  const match = /(?:^|\n)PUPITRE_HTTP (\d{3})\s*$/.exec(result.stdout);
  const status = match ? Number(match[1]) : 0;
  const raw = match ? result.stdout.slice(0, match.index) : result.stdout;
  let parsed: unknown = raw;
  try {
    parsed = raw.trim() ? JSON.parse(raw) : null;
  } catch {
    // Une réponse qui n'est pas du JSON : on la garde telle quelle pour la dire.
  }
  return { status, body: parsed };
}

function apiMessage(response: ApiResponse): string {
  const body = response.body as { message?: unknown; detail?: unknown } | null;
  const message =
    typeof body?.message === 'string'
      ? body.message
      : typeof body?.detail === 'string'
        ? body.detail
        : typeof response.body === 'string'
          ? firstLine(response.body)
          : null;
  return `${response.status || 'pas de réponse'}${message ? ` — ${message}` : ''}`;
}

async function expectOk(
  step: string,
  what: string,
  call: Promise<ApiResponse>,
): Promise<ApiResponse> {
  const response = await call;
  if (response.status < 200 || response.status >= 300) {
    fail(step, `API de BunkerWeb, ${what} : ${apiMessage(response)}`);
  }
  return response;
}

/** Les services connus de BunkerWeb, par leur premier nom de serveur. */
async function listServices(ctx: ProxyHostContext, config: BunkerWebConfig): Promise<string[]> {
  const response = await expectOk(
    'api',
    'liste des services',
    api(ctx, config, 'GET', '/services'),
  );
  const services = (response.body as { services?: unknown } | null)?.services;
  if (!Array.isArray(services)) return [];
  return services
    .map((service) => {
      const item = service as { id?: unknown; server_name?: unknown };
      const name = typeof item.id === 'string' ? item.id : item.server_name;
      return typeof name === 'string' ? (name.split(/\s+/)[0] ?? '') : '';
    })
    .filter(Boolean);
}

// ─── détection ───────────────────────────────────────────────────────────────

type InspectedBunkerWeb = {
  name: string;
  image: string;
  role: 'all-in-one' | 'bunkerweb' | 'api';
};

/**
 * Ce qu'un conteneur dit de lui, sans jamais le jeton : sa présence seule est
 * imprimée (`API_TOKEN=present`), filtrée sur la machine.
 */
async function readContainer(
  ctx: ProxyHostContext,
  name: string,
): Promise<{
  env: Record<string, string>;
  network: string;
  ports: Record<string, string>;
  health: string;
}> {
  const result = await exec(
    ctx.sshSession,
    [
      `C=${shellQuote(name)}`,
      `docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$C" 2>/dev/null | sed -n 's/^API_TOKEN=..*$/env API_TOKEN=present/p; s/^\\(SERVICE_API\\|API_LISTEN_PORT\\|LISTEN_PORT\\|HTTP_PORT\\|HTTPS_PORT\\|AUTOCONF_MODE\\)=\\(.*\\)$/env \\1=\\2/p'`,
      `echo "network $(docker inspect -f '{{.HostConfig.NetworkMode}}' "$C" 2>/dev/null)"`,
      `docker inspect -f '{{range $p, $b := .NetworkSettings.Ports}}{{range $b}}port {{$p}}={{.HostPort}}{{println}}{{end}}{{end}}' "$C" 2>/dev/null`,
      `echo "health $(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$C" 2>/dev/null)"`,
    ].join('\n'),
    { timeout: SHORT_MS },
  );
  const env: Record<string, string> = {};
  const ports: Record<string, string> = {};
  let network = '';
  let health = '';
  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('env ')) {
      const [key, ...value] = trimmed.slice(4).split('=');
      if (key) env[key] = value.join('=');
    } else if (trimmed.startsWith('port ')) {
      const [container, host] = trimmed.slice(5).split('=');
      if (container && host && !ports[container]) ports[container] = host;
    } else if (trimmed.startsWith('network ')) {
      network = trimmed.slice(8).trim();
    } else if (trimmed.startsWith('health ')) {
      health = trimmed.slice(7).trim();
    }
  }
  return { env, network, ports, health };
}

async function dockerBridgeGateway(ctx: ProxyHostContext): Promise<string | null> {
  const result = await exec(
    ctx.sshSession,
    `docker network inspect bridge -f '{{range .IPAM.Config}}{{.Gateway}} {{end}}' 2>/dev/null || true`,
    { timeout: SHORT_MS },
  );
  return result.stdout.split(/\s+/).find((value) => /^\d+\.\d+\.\d+\.\d+$/.test(value)) ?? null;
}

// ─── le provider ─────────────────────────────────────────────────────────────

export class BunkerWebProvider implements ProxyProvider {
  readonly kind = 'bunkerweb' as const;

  parseConfig(config: unknown): BunkerWebConfig {
    return bunkerwebConfigSchema.parse(config);
  }

  /**
   * Une application de sa machine est publiée là où BunkerWeb la joint : la
   * passerelle Docker (ou la boucle locale en réseau hôte) — pas sur toutes
   * les interfaces.
   */
  publishAddress(config: unknown): string | null {
    return this.parseConfig(config).upstreamHost;
  }

  private root(ctx: ProxyHostContext): string {
    return bunkerwebRoot(ctx.target.rootPath);
  }

  // ─── détection ──────────────────────────────────────────────────────────────

  async detect(ctx: ProxyHostContext, onLog: LogSink): Promise<ProxyDetection[]> {
    const listed = await exec(
      ctx.sshSession,
      "command -v docker >/dev/null 2>&1 && docker ps --format '{{.Image}}|{{.Names}}' 2>/dev/null || true",
      { timeout: SHORT_MS },
    );
    const containers: InspectedBunkerWeb[] = [];
    for (const line of listed.stdout.split('\n')) {
      const [image, name] = line.trim().split('|');
      if (!image || !name || !/bunkerity\/bunkerweb/i.test(image)) continue;
      const role = /bunkerweb-all-in-one/i.test(image)
        ? 'all-in-one'
        : /bunkerweb-api/i.test(image)
          ? 'api'
          : /bunkerity\/bunkerweb(:|@|$)/i.test(image)
            ? 'bunkerweb'
            : null;
      if (role) containers.push({ image, name, role });
    }

    const found: ProxyDetection[] = [];
    const fronts = containers.filter((container) => container.role !== 'api');
    const apiContainer = containers.find((container) => container.role === 'api');
    const gateway = await dockerBridgeGateway(ctx);
    for (const front of fronts) {
      const seen = await readContainer(ctx, front.name);
      const apiSource =
        front.role === 'all-in-one'
          ? { name: front.name, ...seen }
          : apiContainer
            ? { name: apiContainer.name, ...(await readContainer(ctx, apiContainer.name)) }
            : null;
      const warnings: string[] = [];
      const hostNetwork = seen.network === 'host';
      const http = hostNetwork ? (seen.env.HTTP_PORT ?? '8080') : seen.ports['8080/tcp'];
      const https = hostNetwork ? (seen.env.HTTPS_PORT ?? '8443') : seen.ports['8443/tcp'];
      if (http !== '80' || https !== '443') {
        warnings.push(
          `BunkerWeb ne reçoit pas les visiteurs sur les ports 80 et 443 de la machine (${http ?? '—'} et ${https ?? '—'}) : les domaines ne lui parviendront pas`,
        );
      }
      let usable = true;
      if (!apiSource || (front.role === 'all-in-one' && apiSource.env.SERVICE_API !== 'yes')) {
        usable = false;
        warnings.push(
          'son API est désactivée : ajoutez SERVICE_API=yes et un API_TOKEN au conteneur, ou laissez Pupitre installer le sien',
        );
      } else if (apiSource.env.API_TOKEN !== 'present') {
        usable = false;
        warnings.push(
          `son API n'a pas d'API_TOKEN (${apiSource.name}) : Pupitre s'authentifie par jeton — ajoutez-en un au conteneur`,
        );
      }
      if (!hostNetwork && !gateway) {
        usable = false;
        warnings.push('la passerelle Docker de la machine est introuvable');
      }
      const summary = `BunkerWeb « ${front.name} » (${front.image})${apiSource && apiSource.name !== front.name ? ` — API : ${apiSource.name}` : ''}`;
      onLog(`conteneur ${front.name} : ${summary}${usable ? '' : ' — inutilisable en l’état'}`);
      found.push({
        kind: 'bunkerweb',
        config:
          usable && apiSource
            ? {
                container: front.name,
                apiContainer: apiSource.name,
                apiPort:
                  Number(apiSource.env.API_LISTEN_PORT ?? apiSource.env.LISTEN_PORT ?? 8888) ||
                  8888,
                upstreamHost: hostNetwork ? '127.0.0.1' : gateway,
                image: null,
                managed: false,
                acme: null,
              }
            : null,
        summary,
        warnings,
      });
    }
    if (found.length === 0) onLog('aucun BunkerWeb sur cette machine');
    return found;
  }

  // ─── installation ───────────────────────────────────────────────────────────

  async installOptions(ctx: ProxyHostContext): Promise<ProxyInstallOption[]> {
    const probe = await exec(
      ctx.sshSession,
      [
        'if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then echo docker=1; else echo docker=0; fi',
        "busy=$( (ss -ltnH 2>/dev/null || netstat -ltn 2>/dev/null) | awk '{print $4}' | grep -E ':(80|443)$' | sed 's/.*://' | sort -u | tr '\\n' ' ')",
        'echo "busy=$busy"',
        `docker ps -a --filter name=^${BUNKERWEB_CONTAINER}$ --format '{{.Names}}' 2>/dev/null | sed 's/^/managed=/'`,
        `docker image inspect ${BUNKERWEB_IMAGE} >/dev/null 2>&1 && echo image=1 || echo image=0`,
        'root=$(docker info -f \'{{.DockerRootDir}}\' 2>/dev/null); [ -n "$root" ] || root=/var/lib/docker',
        'echo "diskkb=$(df -Pk "$root" 2>/dev/null | awk \'NR==2 {print $4}\')"',
        'echo "memkb=$(awk \'/MemAvailable/ {print $2}\' /proc/meminfo 2>/dev/null)"',
      ].join('\n'),
      { timeout: SHORT_MS },
    );
    const value = (key: string) =>
      probe.stdout
        .split('\n')
        .find((line) => line.startsWith(`${key}=`))
        ?.slice(key.length + 1)
        .trim() ?? null;
    const base = {
      kind: 'bunkerweb' as const,
      key: 'container',
      title: 'BunkerWeb en conteneur (WAF)',
      acmeServers: [...BUNKERWEB_ACME_SERVERS],
    };
    if (value('docker') !== '1') {
      return [
        {
          ...base,
          available: false,
          detail:
            'BunkerWeb s’installe en conteneur Docker, absent de cette machine. Pour une machine K3s : reliez-la au BunkerWeb d’une machine Docker (« Ou passer par le reverse proxy d’une autre machine »).',
        },
      ];
    }
    const managed = value('managed') === BUNKERWEB_CONTAINER;
    const busy = (value('busy') ?? '').split(' ').filter(Boolean);
    const diskKb = Number(value('diskkb')) || 0;
    const memKb = Number(value('memkb')) || 0;
    const imagePresent = value('image') === '1';
    if (!managed && busy.length > 0) {
      return [
        {
          ...base,
          available: false,
          detail: `le port ${busy.join(' et ')} est déjà utilisé : un autre serveur web ou proxy tourne ici`,
        },
      ];
    }
    if (!imagePresent && diskKb > 0 && diskKb < IMAGE_DISK_KB) {
      return [
        {
          ...base,
          available: false,
          detail: `l’image de BunkerWeb pèse ~2,1 Go et il ne reste que ${(diskKb / 1024 / 1024).toFixed(1)} Go pour Docker`,
        },
      ];
    }
    const memory =
      memKb > 0 && memKb < MEMORY_WARNING_KB
        ? ` — attention : ${Math.round(memKb / 1024)} Mo de mémoire disponible, BunkerWeb en utilise ~650`
        : '';
    return [
      {
        ...base,
        available: true,
        detail: `installer ${BUNKERWEB_IMAGE} (~2,1 Go, ~650 Mo de mémoire) sur les ports 80 et 443, API activée, interface web non${memory}`,
      },
    ];
  }

  async install(
    ctx: ProxyHostContext,
    request: ProxyInstallRequest,
    onLog: LogSink,
  ): Promise<BunkerWebConfig> {
    const [option] = await this.installOptions(ctx);
    if (!option || option.key !== request.option) {
      fail('install', `installation « ${request.option} » impossible sur cette machine`);
    }
    if (!option.available) fail('install', option.detail);
    if (request.acme.server === 'custom') {
      fail('install', 'BunkerWeb n’accepte que Let’s Encrypt ou ZeroSSL comme autorité');
    }

    const root = this.root(ctx);
    await ensureDirectory(ctx, root, 'bunkerweb');
    await writeFile(ctx, `${root}/compose.yml`, renderBunkerwebCompose(), 'bunkerweb');
    // Le jeton de l'API naît sur la machine et n'en sort pas.
    const token = await exec(
      ctx.sshSession,
      `cd ${shellQuote(root)} && umask 077 && { [ -s api.env ] || printf 'API_TOKEN=%s\\n' "$(od -An -tx1 -N32 /dev/urandom | tr -d ' \\n')" > api.env; } && chmod 600 api.env`,
      { timeout: SHORT_MS },
    );
    if (token.code !== 0)
      fail('install', `jeton de l'API : ${firstLine(token.stderr) ?? `code ${token.code}`}`);

    onLog(`docker compose up — ${BUNKERWEB_IMAGE} (~2,1 Go à télécharger la première fois)`);
    const up = await exec(
      ctx.sshSession,
      `cd ${shellQuote(root)} && docker compose -p ${BUNKERWEB_PROJECT} up -d --pull missing 2>&1`,
      { timeout: INSTALL_MS },
    );
    if (up.code !== 0)
      fail('install', `docker compose up : ${firstLine(up.stdout) ?? `code ${up.code}`}`);

    let health = '';
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const state = await exec(
        ctx.sshSession,
        `docker inspect -f '{{.State.Health.Status}}' ${BUNKERWEB_CONTAINER} 2>/dev/null || true`,
        { timeout: SHORT_MS },
      );
      health = state.stdout.trim();
      if (health === 'healthy') break;
      await sleep(2000);
    }
    if (health !== 'healthy')
      fail(
        'install',
        `BunkerWeb ne répond pas après son démarrage (état : ${health || 'inconnu'})`,
      );

    const gateway = await dockerBridgeGateway(ctx);
    if (!gateway) fail('install', 'la passerelle Docker de la machine est introuvable');
    const config: BunkerWebConfig = {
      container: BUNKERWEB_CONTAINER,
      apiContainer: BUNKERWEB_CONTAINER,
      apiPort: BUNKERWEB_API_PORT,
      upstreamHost: gateway,
      image: BUNKERWEB_IMAGE,
      managed: true,
      acme: request.acme,
    };
    let ping: ApiResponse = { status: 0, body: null };
    for (let attempt = 0; attempt < 30 && ping.status !== 200; attempt += 1) {
      ping = await api(ctx, config, 'GET', '/ping');
      if (ping.status !== 200) await sleep(2000);
    }
    if (ping.status !== 200)
      fail('install', `l’API de BunkerWeb ne répond pas : ${apiMessage(ping)}`);
    onLog('BunkerWeb répond, son API aussi');

    for (const port of [80, 443]) {
      await ufwAllowPort(ctx, port, `${UFW_MARKER}:proxy`, onLog);
    }
    return config;
  }

  async uninstall(ctx: ProxyContext, onLog: LogSink): Promise<void> {
    const config = this.parseConfig(ctx.config);
    if (!config.managed) {
      onLog("BunkerWeb n'a pas été installé par Pupitre : il reste en place");
      return;
    }
    const root = this.root(ctx);
    const down = await exec(
      ctx.sshSession,
      `cd ${shellQuote(root)} 2>/dev/null && docker compose -p ${BUNKERWEB_PROJECT} down -v 2>&1 || docker rm -f ${shellQuote(config.container)} 2>&1 || true`,
      { timeout: INSTALL_MS },
    );
    onLog(firstLine(down.stdout) ?? 'conteneur arrêté');
    await exec(ctx.sshSession, `rm -rf ${shellQuote(root)}`, { timeout: SHORT_MS });
    onLog('BunkerWeb retiré de la machine, données et certificats compris');
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
    const https = await httpCode(ctx, 'https://127.0.0.1/');
    add('https', 'Port 443', https !== 0, https !== 0 ? `répond (${https})` : 'rien n’écoute');

    const state = await exec(
      ctx.sshSession,
      `docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' ${shellQuote(config.container)} 2>/dev/null || true`,
      { timeout: SHORT_MS },
    );
    const running = state.stdout.trim();
    add(
      'container',
      `Conteneur ${config.container}`,
      running.startsWith('running') && !running.includes('unhealthy'),
      running || 'introuvable',
    );

    let apiOk = false;
    try {
      const ping = await api(ctx, config, 'GET', '/ping');
      apiOk = ping.status === 200;
      add('api', 'API de BunkerWeb', apiOk, apiOk ? 'répond, jeton accepté' : apiMessage(ping));
    } catch (error) {
      add('api', 'API de BunkerWeb', false, error instanceof Error ? error.message : String(error));
    }

    if (apiOk && http !== 0) {
      // La preuve que BunkerWeb applique ce qu'on lui confie : un service
      // d'essai vers un port fermé. Appliqué, il répond 502 ; ignoré, la page
      // par défaut.
      const host = `pupitre-check-${randomBytes(4).toString('hex')}.invalid`;
      let code = 0;
      try {
        await expectOk(
          'check',
          'service d’essai',
          api(ctx, config, 'POST', '/services', {
            server_name: host,
            variables: {
              SERVER_NAME: host,
              USE_REVERSE_PROXY: 'yes',
              REVERSE_PROXY_HOST: 'http://127.0.0.1:9',
              REVERSE_PROXY_URL: '/',
              AUTO_LETS_ENCRYPT: 'no',
            },
          }),
        );
        for (let attempt = 0; attempt < 20; attempt += 1) {
          await sleep(1500);
          code = await httpCode(ctx, 'http://127.0.0.1/', host);
          if (code === 502) break;
        }
      } finally {
        await api(ctx, config, 'DELETE', `/services/${host}`).catch(() => undefined);
      }
      add(
        'apply',
        'BunkerWeb applique ce qu’on lui confie',
        code === 502,
        code === 502
          ? 'un service d’essai y a été pris en compte, puis retiré'
          : `service d’essai ignoré (${code || 'pas de réponse'})`,
      );
    }
    return { ok: checks.every((check) => check.ok), checks };
  }

  // ─── les routes ─────────────────────────────────────────────────────────────

  apply(ctx: ProxyContext, set: ProxyRouteSet, onLog: LogSink): Promise<void> {
    return serialized(`${ctx.target.id}`, () => this.applyNow(ctx, set, onLog));
  }

  private async applyNow(ctx: ProxyContext, set: ProxyRouteSet, onLog: LogSink): Promise<void> {
    const config = this.parseConfig(ctx.config);
    const startedAt = Math.floor(Date.now() / 1000) - 5;
    const name = set.scope ? `${set.appSlug}--${set.scope}` : set.appSlug;
    if (set.routes.length > 0 && !set.upstream) {
      fail('apply', "l'application n'expose rien que le proxy puisse joindre");
    }
    if (set.routes.length > 0 && set.upstream?.kind !== 'port') {
      fail(
        'apply',
        'BunkerWeb joint une application par un port publié, pas par un Service du cluster : servez cette machine K3s par une liaison au BunkerWeb d’une machine Docker',
      );
    }

    // Le registre : ce que Pupitre a posé, application par application.
    const directory = `${this.root(ctx)}/routes`;
    const file = `${directory}/${registryFileName(name)}`;
    const registries = await exec(
      ctx.sshSession,
      `for f in ${shellQuote(directory)}/*.json; do [ -f "$f" ] || continue; echo "== $(basename "$f")"; cat "$f"; echo; done`,
      { timeout: SHORT_MS },
    );
    const own = registryFileName(name);
    let previous: string[] = [];
    const others: string[] = [];
    for (const block of registries.stdout.split(/^== /m).filter((part) => part.trim())) {
      const [header, ...rest] = block.split('\n');
      const hostnames = parseRegistry(rest.join('\n')).hostnames;
      if (header?.trim() === own) previous = hostnames;
      else others.push(...hostnames);
    }

    const existing = await listServices(ctx, config);
    const plan = planServices({
      wanted: set.routes.map((route) => route.hostname),
      previous,
      existing,
      others,
    });
    if (plan.foreign.length > 0) {
      fail(
        'apply',
        `${plan.foreign.join(', ')} : déjà un service de BunkerWeb que Pupitre n’a pas créé — retirez-le de BunkerWeb ou choisissez un autre domaine`,
      );
    }

    const routesByHost = new Map(set.routes.map((route) => [route.hostname, route]));
    if (plan.create.length + plan.update.length > 0 && set.upstream?.kind === 'port') {
      const host = set.upstream.host ?? config.upstreamHost;
      const upstream = `http://${host.includes(':') ? `[${host}]` : host}:${set.upstream.port}`;
      const secret = await this.ensureProbeSecret(ctx);
      const variablesOf = (hostname: string) =>
        serviceVariables({ route: routesByHost.get(hostname)!, upstream, acme: config.acme });
      for (const hostname of plan.create) {
        await expectOk(
          'apply',
          `création de ${hostname}`,
          api(
            ctx,
            config,
            'POST',
            '/services',
            { server_name: hostname, variables: variablesOf(hostname) },
            secret,
          ),
        );
      }
      for (const hostname of plan.update) {
        await expectOk(
          'apply',
          `mise à jour de ${hostname}`,
          api(
            ctx,
            config,
            'PATCH',
            `/services/${hostname}`,
            { variables: variablesOf(hostname) },
            secret,
          ),
        );
      }
      onLog(
        `services BunkerWeb : ${[...plan.create, ...plan.update].join(', ')} → ${upstream}` +
          ` (protection : ${set.routes.map((route) => `${route.hostname} ${route.waf}`).join(', ')})`,
      );
    }
    for (const hostname of plan.remove) {
      const removed = await api(ctx, config, 'DELETE', `/services/${hostname}`);
      if (removed.status !== 404 && (removed.status < 200 || removed.status >= 300)) {
        fail('apply', `API de BunkerWeb, retrait de ${hostname} : ${apiMessage(removed)}`);
      }
      onLog(`service BunkerWeb retiré : ${hostname}`);
    }

    // BunkerWeb applique en différé, et revient en silence à la configuration
    // précédente si nginx refuse la nouvelle : on attend de voir les domaines
    // servis, et on dit pourquoi sinon.
    const posed = [...plan.create, ...plan.update];
    if (posed.length > 0) await this.awaitApplied(ctx, config, posed, startedAt);

    // Le registre suit : ce que l'application a maintenant, ni plus ni moins.
    if (set.routes.length === 0) {
      await removeFile(ctx, file, 'bunkerweb');
    } else {
      await ensureDirectory(ctx, directory, 'bunkerweb');
      await writeFile(
        ctx,
        file,
        `${JSON.stringify({ hostnames: set.routes.map((route) => route.hostname) })}\n`,
        'bunkerweb',
      );
    }
  }

  async probe(ctx: ProxyContext, route: ProxyRoute, path: string): Promise<RouteProbe> {
    return probeRoute(ctx, route, path, {
      ...BUNKERWEB_PROBE,
      headerFile: probeHeaderFile(ctx.target.rootPath),
    });
  }

  /**
   * Le secret des sondes : généré sur la machine à la première pose, gardé
   * dans un fichier lisible du seul compte. Rend le chemin du fichier.
   */
  private async ensureProbeSecret(ctx: ProxyHostContext): Promise<string> {
    const file = probeHeaderFile(ctx.target.rootPath);
    await ensureDirectory(ctx, this.root(ctx), 'bunkerweb');
    const made = await exec(
      ctx.sshSession,
      `umask 077; [ -s ${shellQuote(file)} ] || printf '${PROBE_HEADER}: %s\\n' "$(od -An -tx1 -N24 /dev/urandom | tr -d ' \\n')" > ${shellQuote(file)}`,
      { timeout: SHORT_MS },
    );
    if (made.code !== 0) {
      fail('apply', `secret des sondes : ${firstLine(made.stderr) ?? `code ${made.code}`}`);
    }
    return file;
  }

  /**
   * Attendre que BunkerWeb serve ces domaines — plus sa page par défaut. Au
   * bout du délai, ce que son journal dit d'un refus : nginx qui rejette la
   * configuration (`[emerg]`), et BunkerWeb qui revient à la précédente.
   */
  private async awaitApplied(
    ctx: ProxyContext,
    config: BunkerWebConfig,
    hostnames: string[],
    since: number,
  ): Promise<void> {
    const check = hostnames
      .map(
        (hostname) =>
          `curl -s -m 5 -H ${shellQuote(`Host: ${hostname}`)} http://127.0.0.1/ 2>/dev/null | grep -qF ${shellQuote(BUNKERWEB_PROBE.noRouteBody)} && echo ${shellQuote(`waiting ${hostname}`)}`,
      )
      .join('; ');
    let waiting: string[] = hostnames;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const result = await exec(ctx.sshSession, `${check}; true`, { timeout: SHORT_MS });
      waiting = result.stdout
        .split('\n')
        .filter((line) => line.startsWith('waiting '))
        .map((line) => line.slice('waiting '.length).trim());
      if (waiting.length === 0) return;
      await sleep(2000);
    }
    const journal = await exec(
      ctx.sshSession,
      `docker logs --since ${since} ${shellQuote(config.container)} 2>&1 | grep -E '\\[emerg\\]|failing over' | tail -n 3`,
      { timeout: SHORT_MS },
    );
    const emerg = /\[emerg\][^\n]*/.exec(journal.stdout)?.[0];
    fail(
      'apply',
      emerg
        ? `BunkerWeb a refusé la configuration et garde la précédente : ${emerg.replace(/^\[emerg\]\s*/, '')}`
        : `BunkerWeb ne sert pas encore ${waiting.join(', ')} au bout de 40 s`,
    );
  }
}
