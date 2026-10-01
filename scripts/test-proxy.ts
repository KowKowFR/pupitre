/**
 * Le reverse proxy, éprouvé de bout en bout sur les deux runtimes.
 *
 *   pnpm test:proxy <cible-docker> <cible-k3s> [--proxy=traefik|bunkerweb] [--no-acme] [--keep]
 *
 * `--proxy=bunkerweb` éprouve BunkerWeb au lieu de Traefik : il s'installe en
 * conteneur Docker seulement — sur la machine K3s, l'option doit se dire
 * indisponible, et c'est le BunkerWeb de la machine Docker qui sert
 * l'application K3s (proxy central). Son WAF est éprouvé depuis l'autre
 * machine : une injection SQL bloquée en « Protection », qui passe en
 * « Détection seule », et une page et ses ressources jamais limitées.
 * BunkerWeb n'accepte que Let's Encrypt : ses certificats viennent de Pebble
 * par le relais `acme-front`, que le script fait passer, **dans le conteneur
 * de test seulement**, pour Let's Encrypt (`scripts/test-acme/Caddyfile`).
 *
 * D'abord, avant toute installation : les deux machines se joignent-elles ?
 * Dans les deux sens, par l'épreuve même du produit (`checkReach()`) — une
 * connexion ouverte de l'une vers l'autre, sur un port de la plage des
 * applications — et une adresse injoignable doit être dite telle. Sans quoi
 * le proxy central n'est pas exercé, en le disant.
 *
 * Puis, pour chaque cible, avec le même code — seul le driver et le mode de Traefik
 * changent, et ils ne sont nommés nulle part ici :
 *   1. Traefik installé par Pupitre (conteneur, ou le Traefik de K3s réglé),
 *      ses certificats demandés à Pebble — l'ACME de test de Let's Encrypt —
 *      quand il tourne (`docker compose --profile test up -d pebble pebble-dns`) ;
 *   2. « Tester » : il répond, et il lit ce qu'on lui confie ;
 *   3. la détection le retrouve tel qu'on l'a posé ;
 *   4. une application déployée par son driver — côté machine, son port
 *      n'est publié que sur la boucle locale ;
 *   5. deux domaines : l'un en HTTPS avec redirection, l'autre en HTTP seul,
 *      qui répondent à travers le proxy ;
 *   6. le certificat émis par l'ACME, pour de vrai ;
 *   7. un domaine retiré ne répond plus, l'autre si ;
 *   8. tout retiré, application détruite.
 *
 * Puis le proxy central, dans les deux sens : le Traefik d'une machine sert
 * une application qui tourne sur l'autre.
 *   9. l'adresse de l'autre machine, et celle par laquelle le proxy y arrive ;
 *  10. l'application publiée pour lui seul — sur l'adresse privée en Compose,
 *      en NodePort réservé par une NetworkPolicy en K3s (et un proxy qui n'est
 *      pas le bon s'y voit refusé) ;
 *  11. ses domaines répondent à travers le proxy, certificat compris ;
 *  12. tout retiré, rien ne reste chez le proxy ; Traefik désinstallé.
 *
 * Sortie en code 1 dès qu'un point échoue.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decrypt,
  parseAppSpec,
  proxyKindSchema,
  type AcmeSettings,
  type AppSpec,
  type ProxyKind,
} from '@pupitre/core';
import {
  getDriver,
  type DeploymentDriver,
  type DriverContext,
  type RuntimeKind,
} from '@pupitre/core/drivers';
import {
  BUNKERWEB_CONTAINER,
  bunkerwebRoot,
  checkReach,
  defaultDynamicDirectory,
  getProxyProvider,
  reachSource,
  registryFileName,
  REMOTE_NAMESPACE,
  traefikConfigSchema,
  traefikFileName,
  type ProxyContext,
  type ProxyProvider,
  type ProxyRoute,
  type ReachResult,
  type RouteProbe,
} from '@pupitre/core/proxy';
import { connect, disconnect, exec, type SshSession, type SshTarget } from '@pupitre/core/ssh';
import {
  applications,
  closeDb,
  createPortAllocator,
  eq,
  getDb,
  getTargetPortReport,
  getTargetSecret,
  listTargets,
} from '@pupitre/db';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHALLTESTSRV = 'http://127.0.0.1:8055';
/** Le relais qui fait passer Pebble pour Let's Encrypt (profil test). */
const ACME_FRONT = 'pupitre-acme-front-1';
const LETS_ENCRYPT_NAMES = ['acme-staging-v02.api.letsencrypt.org', 'acme-v02.api.letsencrypt.org'];

const ESC = String.fromCharCode(27);
const paint = (code: string) => (text: string) => `${ESC}[${code}m${text}${ESC}[0m`;
const bold = paint('1');
const green = paint('32');
const red = paint('31');
const dim = paint('2');
const write = (text: string) => process.stdout.write(text);

let failures = 0;
let passes = 0;
function record(runtime: string, label: string, ok: boolean, detail = ''): boolean {
  if (ok) passes += 1;
  else failures += 1;
  write(
    `  ${ok ? green('OK') : red('KO')} [${runtime}] ${label}${detail ? ` ${dim(`— ${detail}`)}` : ''}\n`,
  );
  return ok;
}

async function guarded<T>(
  runtime: string,
  label: string,
  run: () => Promise<T>,
): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    record(runtime, label, false, error instanceof Error ? error.message : String(error));
    return null;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── l'application de test ───────────────────────────────────────────────────

const SPEC: AppSpec = parseAppSpec({
  name: 'proxy-probe',
  version: '1.0.0',
  services: [
    {
      name: 'web',
      source: { type: 'image', ref: 'nginx:alpine' },
      port: 80,
      exposed: true,
      healthcheck: { path: '/', intervalSec: 5, timeoutSec: 3, retries: 10 },
    },
  ],
});

async function ensureApplication(spec: AppSpec): Promise<string> {
  const db = getDb();
  const [existing] = await db.select().from(applications).where(eq(applications.slug, spec.name));
  if (existing) return existing.id;
  const [created] = await db
    .insert(applications)
    .values({ slug: spec.name, name: spec.name, appSpec: spec })
    .returning({ id: applications.id });
  if (!created) throw new Error("l'application de test n'a pas été créée");
  return created.id;
}

// ─── une cible ───────────────────────────────────────────────────────────────

type Side = {
  runtime: RuntimeKind;
  driver: DeploymentDriver;
  ctx: DriverContext;
  session: SshSession;
};

async function openSide(runtime: RuntimeKind, ref: string, applicationId: string): Promise<Side> {
  const found = (await listTargets()).find((target) => target.id === ref || target.name === ref);
  if (!found) throw new Error(`cible « ${ref} » introuvable`);
  const stored = await getTargetSecret(found.id);
  if (!stored) throw new Error(`cible « ${ref} » illisible`);
  const secret = decrypt(stored.encryptedCredential);
  const ssh: SshTarget = {
    host: stored.target.host,
    port: stored.target.port,
    username: stored.target.sshUser,
    sudoMethod: stored.target.sudoMethod,
    credentials:
      stored.target.authMethod === 'key'
        ? { authMethod: 'key', privateKey: secret }
        : { authMethod: 'password', password: secret },
  };
  const session = await connect(ssh);
  const ctx: DriverContext = {
    spec: SPEC,
    target: {
      id: found.id,
      name: found.name,
      host: found.host,
      rootPath: process.env.DRIVER_ROOT_PATH ?? '/opt/bootstrap',
    },
    deployment: { id: `proxy-${runtime}-${Date.now()}`, version: SPEC.version, sequence: 1 },
    sshSession: session,
    appSlug: SPEC.name,
    applicationId,
    portAllocator: createPortAllocator(),
    ...(process.env.DRIVER_PORT_RANGE
      ? (() => {
          const [min, max] = process.env.DRIVER_PORT_RANGE.split('-').map(Number);
          return { portRange: { min: min!, max: max! } };
        })()
      : {}),
    resolveSecrets: async () => ({}),
  };
  return { runtime, driver: getDriver(runtime), ctx, session };
}

/** L'adresse de la machine sur le réseau de test, pour le DNS de Pebble. */
async function machineAddress(session: SshSession): Promise<string | null> {
  const result = await exec(
    session,
    "hostname -i 2>/dev/null | awk '{print $1}' || ip -4 -o addr show eth0 | awk '{print $4}' | cut -d/ -f1",
  );
  const address = result.stdout.trim().split(/\s+/)[0];
  return address && /^\d+\.\d+\.\d+\.\d+$/.test(address) ? address : null;
}

async function acmeAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${CHALLTESTSRV}/clear-a`, {
      method: 'POST',
      body: JSON.stringify({ host: 'pupitre-probe.invalid' }),
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function declareDomain(host: string, address: string): Promise<void> {
  const response = await fetch(`${CHALLTESTSRV}/add-a`, {
    method: 'POST',
    body: JSON.stringify({ host, addresses: [address] }),
  });
  if (!response.ok) throw new Error(`DNS de test : ${host} non déclaré (${response.status})`);
}

/**
 * Le Traefik d'un cluster ne voit pas le DNS de Docker : on apprend à CoreDNS
 * où est Pebble, par un bloc de serveur à part — K3s lit `coredns-custom`.
 */
async function teachClusterWherePebbleIs(session: SshSession): Promise<void> {
  const ip = (await exec(session, "getent hosts pebble | awk '{print $1}'")).stdout.trim();
  if (!ip) throw new Error('la machine ne résout pas « pebble »');
  const manifest = JSON.stringify({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: 'coredns-custom', namespace: 'kube-system' },
    data: { 'pebble.server': `pebble:53 {\n  hosts {\n    ${ip} pebble\n  }\n}\n` },
  });
  const kube = 'export KUBECONFIG=${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}; ';
  await exec(
    session,
    `${kube}echo '${manifest}' | kubectl apply -f - && kubectl -n kube-system rollout restart deploy/coredns && kubectl -n kube-system rollout status deploy/coredns --timeout=120s`,
    { timeout: 180_000 },
  );
}

async function forgetPebble(session: SshSession): Promise<void> {
  const kube = 'export KUBECONFIG=${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}; ';
  await exec(
    session,
    `${kube}kubectl -n kube-system delete configmap coredns-custom --ignore-not-found`,
  );
}

async function probeUntil(
  run: () => Promise<RouteProbe>,
  accept: (probe: RouteProbe) => boolean,
  seconds: number,
): Promise<RouteProbe> {
  let probe = await run();
  const deadline = Date.now() + seconds * 1000;
  while (!accept(probe) && Date.now() < deadline) {
    await sleep(3000);
    probe = await run();
  }
  return probe;
}

// ─── le WAF ──────────────────────────────────────────────────────────────────

/**
 * Le WAF, éprouvé depuis l'autre machine — une adresse qu'aucune liste
 * blanche ne couvre, contrairement aux sondes de Pupitre :
 *   - en « Protection », une injection SQL est refusée (403), et une page et
 *     ses ressources — vingt requêtes à la fois — passent toutes ;
 *   - en « Détection seule », la même injection passe ; puis retour à la
 *     protection.
 */
async function exerciseWaf(
  side: Side,
  outsider: Side,
  installed: Installed,
  routes: ProxyRoute[],
  route: ProxyRoute,
  upstream: NonNullable<ReturnType<DeploymentDriver['upstream']>>,
): Promise<void> {
  const { runtime } = side;
  const { provider, proxyCtx } = installed;
  const log = (line: string) => write(`    ${dim(line)}\n`);
  const address = await machineAddress(side.session);
  if (!record(runtime, 'WAF : adresse de la machine du proxy', Boolean(address), address ?? '?')) {
    return;
  }
  const host = `-H 'Host: ${route.hostname}'`;
  const injection = () =>
    exec(
      outsider.session,
      `curl -s -o /dev/null -w '%{http_code}' -m 5 ${host} "http://${address}/?id=1%27%20OR%201=1--" || true`,
    ).then((result) => result.stdout.trim());
  const applyWith = (waf: ProxyRoute['waf']) =>
    provider.apply(
      proxyCtx,
      {
        appSlug: SPEC.name,
        routes: routes.map((candidate) =>
          candidate === route ? { ...candidate, waf } : candidate,
        ),
        upstream,
      },
      log,
    );
  const until = async (expected: string, seconds: number) => {
    let code = await injection();
    const deadline = Date.now() + seconds * 1000;
    while (code !== expected && Date.now() < deadline) {
      await sleep(3000);
      code = await injection();
    }
    return code;
  };

  const blocked = await until('403', 30);
  record(
    runtime,
    `WAF « Protection » : injection SQL refusée depuis ${outsider.ctx.target.name}`,
    blocked === '403',
    `HTTP ${blocked}`,
  );
  const burst = await exec(
    outsider.session,
    `for i in $(seq 1 20); do curl -s -o /dev/null -w '%{http_code}\\n' -m 10 ${host} "http://${address}/?r=$i" & done; wait`,
  );
  const codes = burst.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const tally = [...new Set(codes)].map(
    (code) => `${codes.filter((c) => c === code).length} × ${code}`,
  );
  record(
    runtime,
    'WAF « Protection » : une page et ses ressources (20 requêtes simultanées) passent toutes',
    codes.length === 20 && codes.every((code) => code === '200'),
    tally.join(', '),
  );

  await applyWith('detect');
  const detected = await until('200', 45);
  record(
    runtime,
    'WAF « Détection seule » : la même injection passe, journalisée',
    detected === '200',
    `HTTP ${detected}`,
  );
  await applyWith(route.waf);
}

// ─── le déroulé, par runtime ─────────────────────────────────────────────────

type Installed = {
  side: Side;
  kind: ProxyKind;
  provider: ProxyProvider;
  proxyCtx: ProxyContext;
  kubernetes: boolean;
};

const PROXY_LABEL: Record<ProxyKind, string> = { traefik: 'Traefik', bunkerweb: 'BunkerWeb' };

/**
 * Le relais `acme-front` : son adresse sur le réseau de test et son autorité,
 * lues par Docker sur le poste. `null` : il ne tourne pas.
 */
function acmeFront(): { address: string; ca: string } | null {
  try {
    const address = execFileSync(
      'docker',
      ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', ACME_FRONT],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    const ca = execFileSync(
      'docker',
      ['exec', ACME_FRONT, 'cat', '/data/caddy/pki/authorities/local/root.crt'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return address && ca.includes('BEGIN CERTIFICATE') ? { address, ca } : null;
  } catch {
    return null;
  }
}

/**
 * Dans le conteneur BunkerWeb de test seulement : les noms de Let's Encrypt
 * mènent au relais, et son autorité est reconnue par certbot. Le conteneur
 * recréé, plus rien n'en reste.
 */
async function teachBunkerWebWherePebbleIs(
  session: SshSession,
  front: { address: string; ca: string },
): Promise<void> {
  const ca = Buffer.from(front.ca, 'utf8').toString('base64');
  const result = await exec(
    session,
    [
      `docker exec -u 0 ${BUNKERWEB_CONTAINER} sh -c 'echo "${front.address} ${LETS_ENCRYPT_NAMES.join(' ')}" >> /etc/hosts'`,
      `printf '%s' '${ca}' | base64 -d | docker exec -i -u 0 ${BUNKERWEB_CONTAINER} sh -c 'B=$(PYTHONPATH=/usr/share/bunkerweb/deps/python python3 -c "import certifi; print(certifi.where())") && cat >> "$B" && echo "bundle=$B"'`,
    ].join('\n'),
  );
  if (!/bundle=/.test(result.stdout)) {
    throw new Error(`relais ACME non posé : ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

async function exercise(
  side: Side,
  kind: ProxyKind,
  acme: AcmeSettings | null,
  keep: boolean,
  /** L'autre machine : d'où viennent les requêtes qu'aucune liste blanche ne couvre. */
  outsider: Side | null,
): Promise<Installed | null> {
  const { runtime, driver, ctx, session } = side;
  const provider = getProxyProvider(kind);
  const label = PROXY_LABEL[kind];
  const log = (line: string) => write(`    ${dim(line)}\n`);
  write(`\n${bold(`── ${runtime} — ${ctx.target.name} — ${label}`)}\n`);

  const options = await provider.installOptions(ctx);
  const option = options.find((candidate) => candidate.available);
  // BunkerWeb s'installe en conteneur Docker : sur une machine K3s seule,
  // l'option doit se dire indisponible — en renvoyant vers le proxy central.
  if (kind === 'bunkerweb' && runtime === 'k3s') {
    const refused = options.find((candidate) => !candidate.available);
    record(
      runtime,
      'BunkerWeb : installation indisponible sans Docker, qui renvoie vers la liaison',
      !option && Boolean(refused && /Docker/.test(refused.detail) && /reliez/.test(refused.detail)),
      refused?.detail ?? option?.detail ?? '?',
    );
    return null;
  }
  if (
    !record(
      runtime,
      'une installation possible',
      Boolean(option),
      option ? `${option.key} — ${option.detail}` : options.map((o) => o.detail).join(' · '),
    )
  )
    return null;

  if (acme && option!.key === 'kubernetes') await teachClusterWherePebbleIs(session);
  const config = await guarded(runtime, 'install()', () =>
    provider.install(
      ctx,
      {
        option: option!.key,
        acme: acme ?? {
          email: 'tests@pupitre.test',
          server: 'staging',
          customUrl: null,
          caCertificate: null,
        },
      },
      log,
    ),
  );
  if (!config) return null;
  record(runtime, 'install()', true, option!.key);
  const proxyCtx: ProxyContext = { ...ctx, config };
  const installed: Installed = {
    side,
    kind,
    provider,
    proxyCtx,
    kubernetes: option!.key === 'kubernetes',
  };
  // BunkerWeb ne connaît que Let's Encrypt : dans ce conteneur de test, ses
  // noms mènent à Pebble par le relais.
  if (kind === 'bunkerweb' && acme) {
    const front = acmeFront();
    await guarded(runtime, 'relais ACME de test', async () => {
      if (!front) throw new Error(`${ACME_FRONT} ne tourne pas`);
      await teachBunkerWebWherePebbleIs(session, front);
      return true;
    });
  }

  const check = await guarded(runtime, 'check()', () => provider.check(proxyCtx, log));
  record(
    runtime,
    'check() — « Tester »',
    check?.ok === true,
    check?.checks
      .filter((c) => !c.ok)
      .map((c) => `${c.label} : ${c.detail}`)
      .join(' · ') ?? '',
  );

  const detections = await guarded(runtime, 'detect()', () => provider.detect(ctx, log));
  record(
    runtime,
    `detect() retrouve le ${label} posé`,
    Boolean(detections?.some((detection) => detection.config !== null)),
    detections?.map((detection) => detection.summary).join(' · ') ?? '',
  );

  // L'application, déployée par son driver, publiée là où le proxy la joint.
  const publishAddress = provider.publishAddress(config);
  if (publishAddress) ctx.exposure = { bindAddress: publishAddress };
  const port = await guarded(runtime, 'déploiement', async () => {
    const allocated = await driver.allocatePort(ctx);
    const artifacts = await driver.render(ctx);
    await driver.upload(ctx, artifacts, () => {});
    await driver.build(ctx, () => {});
    const result = await driver.deploy(ctx, () => {});
    const health = await driver.healthcheck(ctx);
    if (!health.healthy) throw new Error(`application en mauvaise santé : ${health.detail ?? ''}`);
    return result.publishedPort ?? allocated;
  });
  // Ce par quoi le proxy la joindra : c'est le driver qui le dit.
  const upstream = driver.upstream(ctx, port);
  if (
    !record(
      runtime,
      'application déployée et saine',
      upstream !== null,
      upstream?.kind === 'port'
        ? `port ${upstream.port}`
        : upstream
          ? 'Service du cluster'
          : 'rien que le proxy puisse joindre',
    )
  )
    return installed;

  if (publishAddress && port) {
    const own = await machineAddress(session);
    const outside = own
      ? await exec(
          session,
          `curl -s -o /dev/null -w '%{http_code}' -m 3 http://${own}:${port}/ || true`,
        )
      : null;
    const inside = await exec(
      session,
      `curl -s -o /dev/null -w '%{http_code}' -m 3 http://${publishAddress}:${port}/ || true`,
    );
    record(
      runtime,
      `port publié là où le proxy le joint seulement (${publishAddress})`,
      inside.stdout.trim() === '200' && outside?.stdout.trim() === '000',
      `${publishAddress} → ${inside.stdout.trim()}, ${own ?? '?'} → ${outside?.stdout.trim() ?? '?'}`,
    );
  }

  const secure: ProxyRoute = {
    hostname: `${runtime}-${kind}.proxy.pupitre.test`,
    tls: true,
    redirectHttps: true,
    waf: 'block',
  };
  const plain: ProxyRoute = {
    hostname: `plain-${runtime}-${kind}.proxy.pupitre.test`,
    tls: false,
    redirectHttps: false,
    waf: 'block',
  };
  if (acme) {
    const address = await machineAddress(session);
    if (address) for (const route of [secure, plain]) await declareDomain(route.hostname, address);
  }

  const applied = await guarded(runtime, 'apply() — deux domaines', async () => {
    await provider.apply(proxyCtx, { appSlug: SPEC.name, routes: [secure, plain], upstream }, log);
    return true;
  });
  if (applied) {
    const securely = await probeUntil(
      () => provider.probe(proxyCtx, secure, '/'),
      (probe) => probe.ok,
      45,
    );
    record(runtime, `${secure.hostname} en HTTPS, HTTP redirigé`, securely.ok, securely.detail);
    const plainly = await probeUntil(
      () => provider.probe(proxyCtx, plain, '/'),
      (probe) => probe.ok,
      30,
    );
    record(runtime, `${plain.hostname} en HTTP`, plainly.ok, plainly.detail);
    if (kind === 'bunkerweb' && outsider) {
      await exerciseWaf(side, outsider, installed, [secure, plain], plain, upstream!);
    }
    if (acme) {
      const issued = await probeUntil(
        () => provider.probe(proxyCtx, secure, '/'),
        (probe) => probe.certificate.status === 'valid',
        180,
      );
      record(
        runtime,
        'certificat émis par l’ACME',
        issued.certificate.status === 'valid',
        `${issued.certificate.status} — ${issued.certificate.issuer ?? '?'} jusqu’au ${issued.certificate.notAfter?.slice(0, 10) ?? '?'}`,
      );
    }

    await provider.apply(proxyCtx, { appSlug: SPEC.name, routes: [secure], upstream }, log);
    const gone = await probeUntil(
      () => provider.probe(proxyCtx, plain, '/'),
      (probe) => !probe.ok,
      30,
    );
    const kept = await provider.probe(proxyCtx, secure, '/');
    record(
      runtime,
      'un domaine retiré ne répond plus, l’autre si',
      !gone.ok && kept.ok,
      `${gone.detail} · ${kept.detail}`,
    );

    await provider.apply(proxyCtx, { appSlug: SPEC.name, routes: [], upstream }, log);
    const none = await probeUntil(
      () => provider.probe(proxyCtx, secure, '/'),
      (probe) => !probe.ok,
      30,
    );
    record(runtime, 'tout retiré : plus rien', !none.ok, none.detail);
  }

  if (!keep) {
    const destroyed = await guarded(runtime, 'destroy()', async () => {
      await driver.destroy(ctx, () => {});
      return true;
    });
    if (destroyed) record(runtime, 'application détruite', true);
  }
  delete ctx.exposure;
  return installed;
}

// ─── le proxy central ────────────────────────────────────────────────────────

/** La plage où les applications de la cible sont publiées, comme le pipeline la retient. */
async function appRange(side: Side): Promise<{ min: number; max: number }> {
  if (side.ctx.portRange) return side.ctx.portRange;
  const report = await getTargetPortReport(side.ctx.target.id);
  return report?.range ?? { min: 30000, max: 32767 };
}

type Reach = { address: string; result: ReachResult };

/**
 * Phase 0 : la machine `from` ouvre-t-elle une connexion vers `to` ? Par
 * l'épreuve du produit, celle du test d'une liaison et du préflight.
 */
async function reachBetween(from: Side, to: Side): Promise<Reach | null> {
  const label = `${from.runtime}→${to.runtime}`;
  const address = await machineAddress(to.session);
  if (!record(label, 'adresse de la machine', Boolean(address), address ?? 'introuvable')) {
    return null;
  }
  const portRange = await appRange(to);
  // Les ports que le panel a réservés sur cette machine : le produit les écarte
  // aussi — un NodePort en service détournerait la connexion d'essai.
  const report = await getTargetPortReport(to.ctx.target.id);
  const reserved = new Set(report?.allocations.map((allocation) => allocation.port) ?? []);
  const result = await guarded(label, 'connexion éprouvée', () =>
    checkReach({
      proxyHost: from.ctx,
      served: to.ctx,
      address: address!,
      portRange,
      reserved,
      onLog: (line) => write(`    ${dim(line)}\n`),
    }),
  );
  if (!result) return null;
  record(
    label,
    `${from.ctx.target.name} joint ${to.ctx.target.name}`,
    result.ok === true,
    `${result.detail}${reachSource(result) ? ` — arrivée depuis ${reachSource(result)}` : ''}`,
  );
  return result.ok === true ? { address: address!, result } : null;
}

/** Et une adresse qui ne mène nulle part est dite telle, sans rien laisser derrière. */
async function unreachableIsSaid(from: Side, to: Side): Promise<void> {
  const label = `${from.runtime}→${to.runtime}`;
  const result = await guarded(label, 'adresse injoignable', () =>
    checkReach({
      proxyHost: from.ctx,
      served: to.ctx,
      // TEST-NET-1 (RFC 5737) : routée par défaut, jamais attribuée.
      address: '192.0.2.1',
      portRange: { min: 30000, max: 30009 },
    }),
  );
  if (!result) return;
  const leftovers = await exec(to.session, 'ls /tmp/pupitre-reach-* 2>/dev/null || true');
  record(
    label,
    'une adresse injoignable est signalée, rien ne reste',
    result.ok === false && leftovers.stdout.trim() === '',
    `${result.failure ?? '?'} — ${result.detail}`,
  );
}

async function redeploy(app: Side, exposure: NonNullable<DriverContext['exposure']>) {
  app.ctx.exposure = exposure;
  app.ctx.deployment = {
    ...app.ctx.deployment,
    id: `proxy-${app.runtime}-${Date.now()}`,
    sequence: app.ctx.deployment.sequence + 1,
  };
  const allocated = await app.driver.allocatePort(app.ctx);
  const artifacts = await app.driver.render(app.ctx);
  await app.driver.upload(app.ctx, artifacts, () => {});
  await app.driver.build(app.ctx, () => {});
  const result = await app.driver.deploy(app.ctx, () => {});
  const health = await app.driver.healthcheck(app.ctx);
  if (!health.healthy) throw new Error(`application en mauvaise santé : ${health.detail ?? ''}`);
  const port = result.publishedPort ?? allocated;
  if (port === null) throw new Error('aucun port publié pour le proxy distant');
  return port;
}

async function crossExercise(
  proxy: Installed,
  app: Side,
  reach: Reach,
  acme: AcmeSettings | null,
  keep: boolean,
): Promise<void> {
  const label = `${proxy.side.runtime}→${app.runtime}`;
  const { provider, proxyCtx } = proxy;
  const log = (line: string) => write(`    ${dim(line)}\n`);
  write(
    `\n${bold(`── proxy central — le ${PROXY_LABEL[proxy.kind]} de ${proxy.side.ctx.target.name} sert ${app.ctx.target.name}`)}\n`,
  );

  // L'adresse et l'arrivée viennent de la phase 0 : la connexion y a été éprouvée.
  const { address } = reach;
  const source = reachSource(reach.result);
  if (
    !record(
      label,
      'liaison : adresse et arrivée du proxy',
      Boolean(source),
      `${address} ← ${source}`,
    )
  )
    return;

  const scope = `t${app.ctx.target.id.slice(0, 8)}`;
  const name = `${SPEC.name}--${scope}`;
  const secure: ProxyRoute = {
    hostname: `${app.runtime}-via-${proxy.side.runtime}-${proxy.kind}.proxy.pupitre.test`,
    tls: true,
    redirectHttps: true,
    waf: 'block',
  };
  const plain: ProxyRoute = {
    hostname: `plain-${app.runtime}-via-${proxy.side.runtime}-${proxy.kind}.proxy.pupitre.test`,
    tls: false,
    redirectHttps: false,
    waf: 'block',
  };
  if (acme) {
    const proxyAddress = await machineAddress(proxy.side.session);
    if (proxyAddress)
      for (const route of [secure, plain]) await declareDomain(route.hostname, proxyAddress);
  }
  const applyRoutes = (routes: ProxyRoute[], port: number | null) =>
    provider.apply(
      proxyCtx,
      {
        appSlug: SPEC.name,
        scope,
        routes,
        upstream: port === null ? null : { kind: 'port', port, host: address! },
      },
      log,
    );

  // Un proxy qui n'est pas le bon : en K3s, la NetworkPolicy le refuse. En
  // Compose, c'est l'adresse de publication qui fait la barrière.
  if (app.runtime === 'k3s') {
    const port = await guarded(label, 'déploiement réservé à une autre adresse', () =>
      redeploy(app, { byPort: true, allowFrom: '192.0.2.1' }),
    );
    if (port === null) return;
    await applyRoutes([plain], port);
    // Concluant seulement une fois la route appliquée : le proxy connaît le
    // domaine, mais ne joint pas l'application (502).
    const refused = await probeUntil(
      () => provider.probe(proxyCtx, plain, '/'),
      (probe) => probe.ok || probe.http === 502,
      60,
    );
    record(
      label,
      'NetworkPolicy : un proxy qui n’est pas le sien est refusé',
      !refused.ok && refused.http === 502,
      refused.detail,
    );
  }

  const port = await guarded(label, 'déploiement pour le proxy distant', () =>
    redeploy(app, { byPort: true, bindAddress: address!, allowFrom: source! }),
  );
  if (port === null) return;
  record(
    label,
    app.runtime === 'k3s' ? `NodePort ${port}, réservé au proxy` : `port ${port} publié`,
    true,
  );

  if (app.runtime === 'docker') {
    const local = await exec(
      app.session,
      `curl -s -o /dev/null -w '%{http_code}' -m 3 http://127.0.0.1:${port}/ || true`,
    );
    const fromProxy = await exec(
      proxy.side.session,
      `curl -s -o /dev/null -w '%{http_code}' -m 3 http://${address}:${port}/ || true`,
    );
    record(
      label,
      'port publié sur l’adresse que joint le proxy, seulement',
      local.stdout.trim() === '000' && fromProxy.stdout.trim() === '200',
      `127.0.0.1 → ${local.stdout.trim()}, ${address} depuis le proxy → ${fromProxy.stdout.trim()}`,
    );
  }

  const applied = await guarded(label, 'apply() vers l’autre machine', async () => {
    await applyRoutes([secure, plain], port);
    return true;
  });
  if (!applied) return;
  const plainly = await probeUntil(
    () => provider.probe(proxyCtx, plain, '/'),
    (probe) => probe.ok,
    60,
  );
  record(label, `${plain.hostname} en HTTP, à travers le proxy`, plainly.ok, plainly.detail);
  const securely = await probeUntil(
    () => provider.probe(proxyCtx, secure, '/'),
    (probe) => probe.ok && (!acme || probe.certificate.status === 'valid'),
    acme ? 180 : 45,
  );
  record(
    label,
    `${secure.hostname} en HTTPS${acme ? ', certificat émis' : ''}`,
    securely.ok && (!acme || securely.certificate.status === 'valid'),
    `${securely.detail} — ${securely.certificate.status}`,
  );

  // Tout retiré : plus de route, et rien ne reste chez le proxy.
  await applyRoutes([], port);
  const gone = await probeUntil(
    () => provider.probe(proxyCtx, plain, '/'),
    (probe) => !probe.ok,
    30,
  );
  // Ce que chaque proxy garderait s'il oubliait : objets du cluster, fichier
  // de routes, ou registre des services BunkerWeb de l'application.
  const leftovers =
    proxy.kind === 'bunkerweb'
      ? await exec(
          proxy.side.session,
          `ls ${bunkerwebRoot(proxy.side.ctx.target.rootPath)}/routes/${registryFileName(name)} 2>/dev/null || true`,
        )
      : proxy.kubernetes
        ? await exec(
            proxy.side.session,
            `export KUBECONFIG=\${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}; kubectl -n ${REMOTE_NAMESPACE} get service,endpointslice,ingress -o name 2>/dev/null | grep -F '${name}' || true`,
          )
        : await exec(
            proxy.side.session,
            `ls ${(() => {
              const config = traefikConfigSchema.parse(proxyCtx.config);
              return (
                (config.mode === 'file' && config.directory) ||
                defaultDynamicDirectory(proxy.side.ctx.target.rootPath)
              );
            })()}/${traefikFileName(name)} 2>/dev/null || true`,
          );
  record(
    label,
    'tout retiré : plus de route, rien ne reste chez le proxy',
    !gone.ok && leftovers.stdout.trim() === '',
    leftovers.stdout.trim() || gone.detail,
  );

  if (!keep) {
    const destroyed = await guarded(label, 'destroy()', async () => {
      await app.driver.destroy(app.ctx, () => {});
      return true;
    });
    if (destroyed) record(label, 'application détruite', true);
  }
  delete app.ctx.exposure;
}

async function teardown(installed: Installed, acme: AcmeSettings | null): Promise<void> {
  const { side, provider, proxyCtx } = installed;
  const removed = await guarded(side.runtime, 'uninstall()', async () => {
    await provider.uninstall(proxyCtx, (line) => write(`    ${dim(line)}\n`));
    return true;
  });
  if (removed) record(side.runtime, `${PROXY_LABEL[installed.kind]} désinstallé`, true);
  if (removed && installed.kubernetes) {
    // Le namespace des routes vers d'autres machines part avec lui.
    const phase = await exec(
      side.session,
      `export KUBECONFIG=\${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}; kubectl get namespace ${REMOTE_NAMESPACE} -o jsonpath='{.status.phase}' 2>/dev/null || true`,
    );
    record(
      side.runtime,
      `namespace ${REMOTE_NAMESPACE} retiré`,
      ['', 'Terminating'].includes(phase.stdout.trim()),
      phase.stdout.trim() || 'absent',
    );
  }
  if (acme && installed.kubernetes) await forgetPebble(side.session);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [dockerRef, k3sRef] = args.filter((arg) => !arg.startsWith('--'));
  if (!dockerRef || !k3sRef) {
    write(
      'Usage : pnpm test:proxy <cible-docker> <cible-k3s> [--proxy=traefik|bunkerweb] [--no-acme] [--keep]\n',
    );
    process.exit(1);
  }
  const kind = proxyKindSchema.parse(
    args.find((arg) => arg.startsWith('--proxy='))?.slice('--proxy='.length) ?? 'traefik',
  );
  const pebble = !args.includes('--no-acme') && (await acmeAvailable());
  // Traefik interroge Pebble directement ; BunkerWeb, qui ne connaît que Let's
  // Encrypt, par le relais qui en prend les noms.
  const acme: AcmeSettings | null = !pebble
    ? null
    : kind === 'bunkerweb'
      ? acmeFront()
        ? { email: 'tests@pupitre.test', server: 'staging', customUrl: null, caCertificate: null }
        : null
      : {
          email: 'tests@pupitre.test',
          server: 'custom',
          customUrl: 'https://pebble:14000/dir',
          caCertificate: readFileSync(
            path.join(ROOT, 'scripts/test-acme/pebble.minica.pem'),
            'utf8',
          ),
        };
  write(bold(`Reverse proxy — ${PROXY_LABEL[kind]} sur les deux runtimes\n`));
  write(
    dim(
      acme
        ? `  certificats : Pebble (ACME de test)${kind === 'bunkerweb' ? ', sous les noms de Let’s Encrypt par acme-front' : ''}\n`
        : `  certificats : non vérifiés — ${pebble ? `${ACME_FRONT} absent` : 'Pebble absent'}\n`,
    ),
  );

  const applicationId = await ensureApplication(SPEC);
  const keep = args.includes('--keep');
  const sides: Side[] = [];
  const installed: Installed[] = [];
  try {
    for (const [runtime, ref] of [
      ['docker', dockerRef],
      ['k3s', k3sRef],
    ] as const) {
      const side = await guarded(runtime, 'ouverture de la cible', () =>
        openSide(runtime, ref, applicationId),
      );
      if (side) sides.push(side);
    }

    // Phase 0 : les deux machines se joignent-elles, dans les deux sens ?
    const reaches = new Map<Side, Reach | null>();
    if (sides.length === 2) {
      write(`\n${bold('── les deux machines se joignent-elles ?')}\n`);
      for (const [from, to] of [sides, [...sides].reverse()] as Array<[Side, Side]>) {
        reaches.set(to, await reachBetween(from, to));
      }
      await unreachableIsSaid(sides[0]!, sides[1]!);
    }

    for (const side of sides) {
      const outsider = sides.find((other) => other !== side) ?? null;
      const done = await exercise(side, kind, acme, keep, outsider);
      if (done) installed.push(done);
    }

    // Le proxy central, dans les deux sens — seulement entre machines qui se joignent.
    for (const proxy of installed) {
      const app = sides.find((side) => side !== proxy.side);
      if (!app) continue;
      const reach = reaches.get(app);
      if (!reach) {
        record(
          `${proxy.side.runtime}→${app.runtime}`,
          'proxy central non exercé : les machines ne se joignent pas (phase 0)',
          false,
        );
        continue;
      }
      await crossExercise(proxy, app, reach, acme, keep);
    }

    if (!keep) for (const done of installed) await teardown(done, acme);
  } finally {
    for (const side of sides) await disconnect(side.session);
  }
  if (!args.includes('--keep')) {
    await getDb().delete(applications).where(eq(applications.id, applicationId));
  }
  await closeDb();
  write(`\n  ${passes} vérification(s) au vert, ${failures} en échec\n`);
  write(
    failures === 0
      ? green(bold('\nLe reverse proxy tient sur les deux runtimes.\n'))
      : red(bold('\nÉchec.\n')),
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error: unknown) => {
  write(red(`\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`));
  await closeDb().catch(() => undefined);
  process.exit(1);
});
