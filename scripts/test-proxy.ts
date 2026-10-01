/**
 * Le reverse proxy, éprouvé de bout en bout sur les deux runtimes.
 *
 *   pnpm test:proxy <cible-docker> <cible-k3s> [--no-acme] [--keep]
 *
 * Pour chaque cible, avec le même code — seul le driver et le mode de Traefik
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
 *   8. tout retiré, application détruite, Traefik désinstallé.
 *
 * Sortie en code 1 dès qu'un point échoue.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decrypt, parseAppSpec, type AcmeSettings, type AppSpec } from '@pupitre/core';
import {
  getDriver,
  type DeploymentDriver,
  type DriverContext,
  type RuntimeKind,
} from '@pupitre/core/drivers';
import {
  getProxyProvider,
  type ProxyContext,
  type ProxyRoute,
  type RouteProbe,
} from '@pupitre/core/proxy';
import { connect, disconnect, exec, type SshSession, type SshTarget } from '@pupitre/core/ssh';
import {
  applications,
  closeDb,
  createPortAllocator,
  eq,
  getDb,
  getTargetSecret,
  listTargets,
} from '@pupitre/db';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHALLTESTSRV = 'http://127.0.0.1:8055';

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

// ─── le déroulé, par runtime ─────────────────────────────────────────────────

async function exercise(side: Side, acme: AcmeSettings | null, keep: boolean): Promise<void> {
  const { runtime, driver, ctx, session } = side;
  const provider = getProxyProvider('traefik');
  const log = (line: string) => write(`    ${dim(line)}\n`);
  write(`\n${bold(`── ${runtime} — ${ctx.target.name}`)}\n`);

  const options = await provider.installOptions(ctx);
  const option = options.find((candidate) => candidate.available);
  if (
    !record(
      runtime,
      'une installation possible',
      Boolean(option),
      option ? `${option.key} — ${option.detail}` : options.map((o) => o.detail).join(' · '),
    )
  )
    return;

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
  if (!config) return;
  record(runtime, 'install()', true, option!.key);
  const proxyCtx: ProxyContext = { ...ctx, config };

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
    'detect() retrouve le Traefik posé',
    Boolean(detections?.some((detection) => detection.config !== null)),
    detections?.map((detection) => detection.summary).join(' · ') ?? '',
  );

  // L'application, déployée par son driver, publiée là où le proxy la joint.
  const publishAddress = provider.publishAddress(config);
  if (publishAddress) ctx.publishAddress = publishAddress;
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
    return;

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
      `curl -s -o /dev/null -w '%{http_code}' -m 3 http://127.0.0.1:${port}/ || true`,
    );
    record(
      runtime,
      'port publié sur la boucle locale seulement',
      inside.stdout.trim() === '200' && outside?.stdout.trim() === '000',
      `127.0.0.1 → ${inside.stdout.trim()}, ${own ?? '?'} → ${outside?.stdout.trim() ?? '?'}`,
    );
  }

  const secure: ProxyRoute = {
    hostname: `${runtime}.proxy.pupitre.test`,
    tls: true,
    redirectHttps: true,
  };
  const plain: ProxyRoute = {
    hostname: `plain-${runtime}.proxy.pupitre.test`,
    tls: false,
    redirectHttps: false,
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

  if (keep) return;
  await guarded(runtime, 'destroy()', () => driver.destroy(ctx, () => {}));
  const removed = await guarded(runtime, 'uninstall()', async () => {
    await provider.uninstall(proxyCtx, log);
    return true;
  });
  if (removed) record(runtime, 'application détruite, Traefik désinstallé', true);
  if (acme && option!.key === 'kubernetes') await forgetPebble(session);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [dockerRef, k3sRef] = args.filter((arg) => !arg.startsWith('--'));
  if (!dockerRef || !k3sRef) {
    write('Usage : pnpm test:proxy <cible-docker> <cible-k3s> [--no-acme] [--keep]\n');
    process.exit(1);
  }
  const acme: AcmeSettings | null =
    !args.includes('--no-acme') && (await acmeAvailable())
      ? {
          email: 'tests@pupitre.test',
          server: 'custom',
          customUrl: 'https://pebble:14000/dir',
          caCertificate: readFileSync(
            path.join(ROOT, 'scripts/test-acme/pebble.minica.pem'),
            'utf8',
          ),
        }
      : null;
  write(bold('Reverse proxy — Traefik sur les deux runtimes\n'));
  write(
    dim(
      acme
        ? '  certificats : Pebble (ACME de test)\n'
        : '  certificats : non vérifiés — Pebble absent\n',
    ),
  );

  const applicationId = await ensureApplication(SPEC);
  for (const [runtime, ref] of [
    ['docker', dockerRef],
    ['k3s', k3sRef],
  ] as const) {
    const side = await guarded(runtime, 'ouverture de la cible', () =>
      openSide(runtime, ref, applicationId),
    );
    if (!side) continue;
    try {
      await exercise(side, acme, args.includes('--keep'));
    } finally {
      await disconnect(side.session);
    }
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
