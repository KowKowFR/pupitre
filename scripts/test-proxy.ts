/**
 * The reverse proxy, tried out end to end on both runtimes.
 *
 *   pnpm test:proxy <docker-target> <k3s-target> [--proxy=traefik|bunkerweb] [--no-acme] [--keep]
 *
 * `--proxy=bunkerweb` tries out BunkerWeb instead of Traefik: it only installs
 * as a Docker container — on the K3s machine, the option must call itself
 * unavailable, and it is the Docker machine's BunkerWeb that serves the K3s
 * application (central proxy). Its WAF is tried out from the other machine: an
 * SQL injection blocked in "Protection", which goes through in "Detection
 * only", and a page and its resources never rate limited. BunkerWeb only
 * accepts Let's Encrypt: its certificates come from Pebble through the
 * `acme-front` relay, which the script passes off as Let's Encrypt, **in the
 * test container only** (`scripts/test-acme/Caddyfile`).
 *
 * First, before any installation: do the two machines reach each other? Both
 * ways, through the product's own trial (`checkReach()`) — a connection opened
 * from one to the other, on a port of the applications' range — and an
 * unreachable address must be called so. Otherwise the central proxy is not
 * exercised, saying so.
 *
 * Then, for each target, with the same code — only the driver and Traefik's
 * mode change, and they are named nowhere here:
 *   1. Traefik installed by Pupitre (container, or K3s's Traefik configured),
 *      its certificates requested from Pebble — Let's Encrypt's test ACME —
 *      when it runs (`docker compose --profile test up -d pebble pebble-dns`);
 *   2. "Test": it answers, and it reads what is handed to it;
 *   3. the detection finds it as it was set;
 *   4. an application deployed by its driver — on the machine side, its port
 *      is only published on the loopback;
 *   5. two domains: one over HTTPS with a redirect, the other over HTTP only,
 *      which answer through the proxy;
 *   6. the certificate issued by the ACME, for real;
 *   7. a removed domain no longer answers, the other one does;
 *   8. everything removed, application destroyed.
 *
 * Then the central proxy, both ways: one machine's Traefik serves an
 * application that runs on the other.
 *   9. the other machine's address, and the one through which the proxy gets
 *      there;
 *  10. the application published for it alone — on the private address with
 *      Compose, as a NodePort restricted by a NetworkPolicy with K3s (and a
 *      proxy that is not the right one is refused there);
 *  11. its domains answer through the proxy, certificate included;
 *  12. everything removed, nothing remains at the proxy; Traefik uninstalled.
 *
 * Exit code 1 as soon as a point fails.
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
  sshReachOrigin,
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
/** The relay that passes Pebble off as Let's Encrypt (test profile). */
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

// ─── the test application ────────────────────────────────────────────────────

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
  if (!created) throw new Error('the test application was not created');
  return created.id;
}

// ─── a target ────────────────────────────────────────────────────────────────

type Side = {
  runtime: RuntimeKind;
  driver: DeploymentDriver;
  ctx: DriverContext;
  session: SshSession;
};

async function openSide(runtime: RuntimeKind, ref: string, applicationId: string): Promise<Side> {
  const found = (await listTargets()).find((target) => target.id === ref || target.name === ref);
  if (!found) throw new Error(`target "${ref}" not found`);
  const stored = await getTargetSecret(found.id);
  if (!stored) throw new Error(`target "${ref}" unreadable`);
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
    language: 'fr',
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

/** The machine's address on the test network, for Pebble's DNS. */
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
  if (!response.ok) throw new Error(`test DNS: ${host} not declared (${response.status})`);
}

/**
 * A cluster's Traefik does not see Docker's DNS: we teach CoreDNS where Pebble
 * is, through a separate server block — K3s reads `coredns-custom`.
 */
async function teachClusterWherePebbleIs(session: SshSession): Promise<void> {
  const ip = (await exec(session, "getent hosts pebble | awk '{print $1}'")).stdout.trim();
  if (!ip) throw new Error('the machine does not resolve "pebble"');
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

// ─── the WAF ─────────────────────────────────────────────────────────────────

/**
 * The WAF, tried out from the other machine — an address no allow list covers,
 * unlike Pupitre's probes:
 *   - in "Protection", an SQL injection is refused (403), and a page and its
 *     resources — twenty requests at once — all go through;
 *   - in "Detection only", the same injection goes through; then back to
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
  if (!record(runtime, "WAF: the proxy machine's address", Boolean(address), address ?? '?')) {
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
    `WAF "Protection": SQL injection refused from ${outsider.ctx.target.name}`,
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
    'WAF "Protection": a page and its resources (20 simultaneous requests) all go through',
    codes.length === 20 && codes.every((code) => code === '200'),
    tally.join(', '),
  );

  await applyWith('detect');
  const detected = await until('200', 45);
  record(
    runtime,
    'WAF "Detection only": the same injection goes through, logged',
    detected === '200',
    `HTTP ${detected}`,
  );
  await applyWith(route.waf);
}

// ─── the run, per runtime ────────────────────────────────────────────────────

type Installed = {
  side: Side;
  kind: ProxyKind;
  provider: ProxyProvider;
  proxyCtx: ProxyContext;
  kubernetes: boolean;
};

const PROXY_LABEL: Record<ProxyKind, string> = {
  traefik: 'Traefik',
  bunkerweb: 'BunkerWeb',
  npm: 'Nginx Proxy Manager',
};

/**
 * The `acme-front` relay: its address on the test network and its authority,
 * read by Docker on the workstation. `null`: it is not running.
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
 * In the test BunkerWeb container only: Let's Encrypt's names lead to the
 * relay, and its authority is recognized by certbot. Once the container is
 * recreated, nothing of it remains.
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
    throw new Error(`ACME relay not set: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

async function exercise(
  side: Side,
  kind: ProxyKind,
  acme: AcmeSettings | null,
  keep: boolean,
  /** The other machine: where the requests no allow list covers come from. */
  outsider: Side | null,
): Promise<Installed | null> {
  const { runtime, driver, ctx, session } = side;
  const provider = getProxyProvider(kind);
  const label = PROXY_LABEL[kind];
  const log = (line: string) => write(`    ${dim(line)}\n`);
  write(`\n${bold(`── ${runtime} — ${ctx.target.name} — ${label}`)}\n`);

  const options = await provider.installOptions(ctx);
  const option = options.find((candidate) => candidate.available);
  // BunkerWeb installs as a Docker container: on a K3s machine alone, the option
  // must call itself unavailable — pointing to the central proxy.
  if (kind === 'bunkerweb' && runtime === 'k3s') {
    const refused = options.find((candidate) => !candidate.available);
    record(
      runtime,
      'BunkerWeb: installation unavailable without Docker, pointing to the link',
      !option && Boolean(refused && /Docker/.test(refused.detail) && /reliez/.test(refused.detail)),
      refused?.detail ?? option?.detail ?? '?',
    );
    return null;
  }
  if (
    !record(
      runtime,
      'a possible installation',
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
  // BunkerWeb only knows Let's Encrypt: in this test container, its names lead
  // to Pebble through the relay.
  if (kind === 'bunkerweb' && acme) {
    const front = acmeFront();
    await guarded(runtime, 'test ACME relay', async () => {
      if (!front) throw new Error(`${ACME_FRONT} is not running`);
      await teachBunkerWebWherePebbleIs(session, front);
      return true;
    });
  }

  const check = await guarded(runtime, 'check()', () => provider.check(proxyCtx, log));
  record(
    runtime,
    'check() — "Test"',
    check?.ok === true,
    check?.checks
      .filter((c) => !c.ok)
      .map((c) => `${c.label}: ${c.detail}`)
      .join(' · ') ?? '',
  );

  const detections = await guarded(runtime, 'detect()', () => provider.detect(ctx, log));
  record(
    runtime,
    `detect() finds the ${label} that was set`,
    Boolean(detections?.some((detection) => detection.config !== null)),
    detections?.map((detection) => detection.summary).join(' · ') ?? '',
  );

  // The application, deployed by its driver, published where the proxy reaches it.
  const publishAddress = provider.publishAddress(config);
  if (publishAddress) ctx.exposure = { bindAddress: publishAddress };
  const port = await guarded(runtime, 'deployment', async () => {
    const allocated = await driver.allocatePort(ctx);
    const artifacts = await driver.render(ctx);
    await driver.upload(ctx, artifacts, () => {});
    await driver.build(ctx, () => {});
    const result = await driver.deploy(ctx, () => {});
    const health = await driver.healthcheck(ctx);
    if (!health.healthy) throw new Error(`unhealthy application: ${health.detail ?? ''}`);
    return result.publishedPort ?? allocated;
  });
  // What the proxy will reach it through: it is the driver that says so.
  const upstream = driver.upstream(ctx, port);
  if (
    !record(
      runtime,
      'application deployed and healthy',
      upstream !== null,
      upstream?.kind === 'port'
        ? `port ${upstream.port}`
        : upstream
          ? 'cluster Service'
          : 'nothing the proxy can reach',
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
      `port published only where the proxy reaches it (${publishAddress})`,
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
    record(runtime, `${secure.hostname} over HTTPS, HTTP redirected`, securely.ok, securely.detail);
    const plainly = await probeUntil(
      () => provider.probe(proxyCtx, plain, '/'),
      (probe) => probe.ok,
      30,
    );
    record(runtime, `${plain.hostname} over HTTP`, plainly.ok, plainly.detail);
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
        'certificate issued by the ACME',
        issued.certificate.status === 'valid',
        `${issued.certificate.status} — ${issued.certificate.issuer ?? '?'} until ${issued.certificate.notAfter?.slice(0, 10) ?? '?'}`,
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
      'a removed domain no longer answers, the other one does',
      !gone.ok && kept.ok,
      `${gone.detail} · ${kept.detail}`,
    );

    await provider.apply(proxyCtx, { appSlug: SPEC.name, routes: [], upstream }, log);
    const none = await probeUntil(
      () => provider.probe(proxyCtx, secure, '/'),
      (probe) => !probe.ok,
      30,
    );
    record(runtime, 'everything removed: nothing left', !none.ok, none.detail);
  }

  if (!keep) {
    const destroyed = await guarded(runtime, 'destroy()', async () => {
      await driver.destroy(ctx, () => {});
      return true;
    });
    if (destroyed) record(runtime, 'application destroyed', true);
  }
  delete ctx.exposure;
  return installed;
}

// ─── the central proxy ───────────────────────────────────────────────────────

/** The range where the target's applications are published, as the pipeline keeps it. */
async function appRange(side: Side): Promise<{ min: number; max: number }> {
  if (side.ctx.portRange) return side.ctx.portRange;
  const report = await getTargetPortReport(side.ctx.target.id);
  return report?.range ?? { min: 30000, max: 32767 };
}

type Reach = { address: string; result: ReachResult };

/**
 * Phase 0: does the `from` machine open a connection to `to`? Through the
 * product's trial, the one of a link's test and of the preflight.
 */
async function reachBetween(from: Side, to: Side): Promise<Reach | null> {
  const label = `${from.runtime}→${to.runtime}`;
  const address = await machineAddress(to.session);
  if (!record(label, "the machine's address", Boolean(address), address ?? 'not found')) {
    return null;
  }
  const portRange = await appRange(to);
  // The ports the panel reserved on this machine: the product sets them aside
  // too — a NodePort in service would hijack the trial connection.
  const report = await getTargetPortReport(to.ctx.target.id);
  const reserved = new Set(report?.allocations.map((allocation) => allocation.port) ?? []);
  const result = await guarded(label, 'connection tried out', () =>
    checkReach({
      origin: sshReachOrigin(from.ctx),
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
    `${from.ctx.target.name} reaches ${to.ctx.target.name}`,
    result.ok === true,
    `${result.detail}${reachSource(result) ? ` — arrival from ${reachSource(result)}` : ''}`,
  );
  return result.ok === true ? { address: address!, result } : null;
}

/** And an address that leads nowhere is called so, without leaving anything behind. */
async function unreachableIsSaid(from: Side, to: Side): Promise<void> {
  const label = `${from.runtime}→${to.runtime}`;
  const result = await guarded(label, 'unreachable address', () =>
    checkReach({
      origin: sshReachOrigin(from.ctx),
      served: to.ctx,
      // TEST-NET-1 (RFC 5737): routed by default, never assigned.
      address: '192.0.2.1',
      portRange: { min: 30000, max: 30009 },
    }),
  );
  if (!result) return;
  const leftovers = await exec(to.session, 'ls /tmp/pupitre-reach-* 2>/dev/null || true');
  record(
    label,
    'an unreachable address is reported, nothing remains',
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
  if (!health.healthy) throw new Error(`unhealthy application: ${health.detail ?? ''}`);
  const port = result.publishedPort ?? allocated;
  if (port === null) throw new Error('no port published for the remote proxy');
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
    `\n${bold(`── central proxy — the ${PROXY_LABEL[proxy.kind]} of ${proxy.side.ctx.target.name} serves ${app.ctx.target.name}`)}\n`,
  );

  // The address and the arrival come from phase 0: the connection was tried out there.
  const { address } = reach;
  const source = reachSource(reach.result);
  if (
    !record(
      label,
      "link: the proxy's address and arrival",
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

  // A proxy that is not the right one: with K3s, the NetworkPolicy refuses it.
  // With Compose, it is the publication address that makes the barrier.
  if (app.runtime === 'k3s') {
    const port = await guarded(label, 'deployment reserved for another address', () =>
      redeploy(app, { byPort: true, allowFrom: '192.0.2.1' }),
    );
    if (port === null) return;
    await applyRoutes([plain], port);
    // Conclusive only once the route is applied: the proxy knows the domain, but
    // does not reach the application (502).
    const refused = await probeUntil(
      () => provider.probe(proxyCtx, plain, '/'),
      (probe) => probe.ok || probe.http === 502,
      60,
    );
    record(
      label,
      'NetworkPolicy: a proxy that is not its own is refused',
      !refused.ok && refused.http === 502,
      refused.detail,
    );
  }

  const port = await guarded(label, 'deployment for the remote proxy', () =>
    redeploy(app, { byPort: true, bindAddress: address!, allowFrom: source! }),
  );
  if (port === null) return;
  record(
    label,
    app.runtime === 'k3s' ? `NodePort ${port}, reserved for the proxy` : `port ${port} published`,
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
      'port published only on the address the proxy reaches',
      local.stdout.trim() === '000' && fromProxy.stdout.trim() === '200',
      `127.0.0.1 → ${local.stdout.trim()}, ${address} from the proxy → ${fromProxy.stdout.trim()}`,
    );
  }

  const applied = await guarded(label, 'apply() to the other machine', async () => {
    await applyRoutes([secure, plain], port);
    return true;
  });
  if (!applied) return;
  const plainly = await probeUntil(
    () => provider.probe(proxyCtx, plain, '/'),
    (probe) => probe.ok,
    60,
  );
  record(label, `${plain.hostname} over HTTP, through the proxy`, plainly.ok, plainly.detail);
  const securely = await probeUntil(
    () => provider.probe(proxyCtx, secure, '/'),
    (probe) => probe.ok && (!acme || probe.certificate.status === 'valid'),
    acme ? 180 : 45,
  );
  record(
    label,
    `${secure.hostname} over HTTPS${acme ? ', certificate issued' : ''}`,
    securely.ok && (!acme || securely.certificate.status === 'valid'),
    `${securely.detail} — ${securely.certificate.status}`,
  );

  // Everything removed: no route left, and nothing remains at the proxy.
  await applyRoutes([], port);
  const gone = await probeUntil(
    () => provider.probe(proxyCtx, plain, '/'),
    (probe) => !probe.ok,
    30,
  );
  // What each proxy would keep if it forgot: cluster objects, routes file, or
  // the application's BunkerWeb services registry.
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
    'everything removed: no route left, nothing remains at the proxy',
    !gone.ok && leftovers.stdout.trim() === '',
    leftovers.stdout.trim() || gone.detail,
  );

  if (!keep) {
    const destroyed = await guarded(label, 'destroy()', async () => {
      await app.driver.destroy(app.ctx, () => {});
      return true;
    });
    if (destroyed) record(label, 'application destroyed', true);
  }
  delete app.ctx.exposure;
}

async function teardown(installed: Installed, acme: AcmeSettings | null): Promise<void> {
  const { side, provider, proxyCtx } = installed;
  const removed = await guarded(side.runtime, 'uninstall()', async () => {
    await provider.uninstall(proxyCtx, (line) => write(`    ${dim(line)}\n`));
    return true;
  });
  if (removed) record(side.runtime, `${PROXY_LABEL[installed.kind]} uninstalled`, true);
  if (removed && installed.kubernetes) {
    // The namespace of the routes to other machines goes with it.
    const phase = await exec(
      side.session,
      `export KUBECONFIG=\${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}; kubectl get namespace ${REMOTE_NAMESPACE} -o jsonpath='{.status.phase}' 2>/dev/null || true`,
    );
    record(
      side.runtime,
      `namespace ${REMOTE_NAMESPACE} removed`,
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
      'Usage: pnpm test:proxy <docker-target> <k3s-target> [--proxy=traefik|bunkerweb] [--no-acme] [--keep]\n',
    );
    process.exit(1);
  }
  const kind = proxyKindSchema.parse(
    args.find((arg) => arg.startsWith('--proxy='))?.slice('--proxy='.length) ?? 'traefik',
  );
  const pebble = !args.includes('--no-acme') && (await acmeAvailable());
  // Traefik queries Pebble directly; BunkerWeb, which only knows Let's Encrypt,
  // through the relay that takes its names.
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
  write(bold(`Reverse proxy — ${PROXY_LABEL[kind]} on both runtimes\n`));
  write(
    dim(
      acme
        ? `  certificates: Pebble (test ACME)${kind === 'bunkerweb' ? ", under Let's Encrypt's names through acme-front" : ''}\n`
        : `  certificates: not checked — ${pebble ? `${ACME_FRONT} missing` : 'Pebble missing'}\n`,
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
      const side = await guarded(runtime, 'opening the target', () =>
        openSide(runtime, ref, applicationId),
      );
      if (side) sides.push(side);
    }

    // Phase 0: do the two machines reach each other, both ways?
    const reaches = new Map<Side, Reach | null>();
    if (sides.length === 2) {
      write(`\n${bold('── do the two machines reach each other?')}\n`);
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

    // The central proxy, both ways — only between machines that reach each other.
    for (const proxy of installed) {
      const app = sides.find((side) => side !== proxy.side);
      if (!app) continue;
      const reach = reaches.get(app);
      if (!reach) {
        record(
          `${proxy.side.runtime}→${app.runtime}`,
          'central proxy not exercised: the machines do not reach each other (phase 0)',
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
  write(`\n  ${passes} check(s) green, ${failures} failing\n`);
  write(
    failures === 0
      ? green(bold('\nThe reverse proxy holds on both runtimes.\n'))
      : red(bold('\nFailure.\n')),
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error: unknown) => {
  write(red(`\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`));
  await closeDb().catch(() => undefined);
  process.exit(1);
});
