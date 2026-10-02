/**
 * Nginx Proxy Manager de bout en bout — un proxy **distant**, piloté par son API.
 *
 *   docker compose --profile test up -d pebble pebble-dns npm-proxy
 *   pnpm test:npm <cible-docker> <cible-k3s>
 *
 * Contre une vraie instance (2.16), avec un compte aux droits restreints :
 *   0. l'instance répond ; son administrateur crée le compte de Pupitre —
 *      « Manage » sur les Proxy Hosts et les SSL Certificates, visibilité
 *      « Created Items » ;
 *   1. « Tester » passe ; un mauvais mot de passe est refusé, en le disant ;
 *   2. la liaison, éprouvée **à travers NPM** vers chaque cible (`checkReach`),
 *      l'arrivée relevée ; une adresse qui ne mène nulle part est dite telle,
 *      et aucun hôte de test ne reste ;
 *   3. sur chaque runtime, une application publiée pour NPM seul et son
 *      domaine posé : HTTP renvoie vers HTTPS, certificat émis par Pebble,
 *      sondé depuis le panel ;
 *   4. ce qui n'est pas à Pupitre reste : l'hôte d'un autre compte n'est pas
 *      touché, et son domaine, réclamé, est refusé en le disant ;
 *   5. un certificat déjà dans NPM qui couvre le domaine (un joker) est repris ;
 *   6. le retrait : les hôtes de Pupitre partent avec ses certificats ; le joker
 *      et l'hôte de l'autre compte restent ; une machine ne touche pas l'autre.
 * Puis tout est retiré : applications, hôtes, certificats, compte, DNS de test.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { decrypt, parseAppSpec } from '@pupitre/core';
import {
  getDriver,
  type DeploymentDriver,
  type DriverContext,
  type RuntimeKind,
} from '@pupitre/core/drivers';
import {
  checkReach,
  getRemoteProxyProvider,
  reachSource,
  type ProxyRoute,
  type ReachOrigin,
  type RemoteProxyContext,
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

const NPM_URL = process.env.NPM_TEST_URL ?? 'http://127.0.0.1:8181';
const ENTRYPOINT = {
  host: '127.0.0.1',
  httpPort: Number(process.env.NPM_TEST_HTTP_PORT ?? 8480),
  httpsPort: Number(process.env.NPM_TEST_HTTPS_PORT ?? 8443),
};
const ADMIN = {
  email: 'admin@npm.pupitre.test',
  password: process.env.NPM_TEST_ADMIN_PASSWORD ?? 'npm-test-admin',
};
const PUPITRE = { email: 'pupitre@npm.pupitre.test', password: 'pupitre-npm-test' };
const CHALLTESTSRV = 'http://127.0.0.1:8055';
const DOMAIN = 'npm.pupitre.test';

const ESC = String.fromCharCode(27);
const paint = (code: string) => (text: string) => `${ESC}[${code}m${text}${ESC}[0m`;
const green = paint('32');
const red = paint('31');
const bold = paint('1');
const dim = paint('2');
const write = (text: string) => process.stdout.write(text);
const log = (line: string) => write(`    ${dim(line)}\n`);

let passes = 0;
let failures = 0;
function record(scope: string, label: string, ok: boolean, detail = ''): boolean {
  if (ok) passes += 1;
  else failures += 1;
  write(
    `  ${ok ? green('OK') : red('KO')} [${scope}] ${label}${detail ? ` ${dim(`— ${detail}`)}` : ''}\n`,
  );
  return ok;
}

async function guarded<T>(scope: string, label: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    record(scope, label, false, error instanceof Error ? error.message : String(error));
    return null;
  }
}

const SPEC = parseAppSpec({
  name: 'npm-essai',
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

// ─── l'instance NPM, côté administrateur ─────────────────────────────────────

async function npm<T>(token: string | null, method: string, route: string, body?: unknown) {
  const response = await fetch(`${NPM_URL}/api${route}`, {
    method,
    headers: {
      ...(body !== undefined && !(body instanceof FormData)
        ? { 'content-type': 'application/json' }
        : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${route} : HTTP ${response.status} ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

async function login(email: string, password: string): Promise<string> {
  const answer = await npm<{ token: string }>(null, 'POST', '/tokens', {
    identity: email,
    secret: password,
  });
  return answer.token;
}

/** Le compte de Pupitre, tel que la documentation le conseille. */
async function ensurePupitreAccount(admin: string): Promise<number> {
  const users = await npm<Array<{ id: number; email: string }>>(admin, 'GET', '/users');
  const found = users.find((user) => user.email === PUPITRE.email);
  const id =
    found?.id ??
    (
      await npm<{ id: number }>(admin, 'POST', '/users', {
        name: 'Pupitre',
        nickname: 'pupitre',
        email: PUPITRE.email,
        roles: [],
        is_disabled: false,
      })
    ).id;
  await npm(admin, 'PUT', `/users/${id}/auth`, { type: 'password', secret: PUPITRE.password });
  await npm(admin, 'PUT', `/users/${id}/permissions`, {
    visibility: 'user',
    proxy_hosts: 'manage',
    certificates: 'manage',
    redirection_hosts: 'hidden',
    dead_hosts: 'hidden',
    streams: 'hidden',
    access_lists: 'hidden',
  });
  return id;
}

type Host = {
  id: number;
  domain_names: string[];
  certificate_id: number;
  meta: Record<string, unknown>;
};
type Certificate = { id: number; nice_name: string; domain_names: string[] };

// ─── les cibles ──────────────────────────────────────────────────────────────

type Side = {
  runtime: RuntimeKind;
  driver: DeploymentDriver;
  ctx: DriverContext;
  session: SshSession;
  address: string;
  hostname: string;
};

async function ensureApplication(): Promise<string> {
  const db = getDb();
  const [existing] = await db.select().from(applications).where(eq(applications.slug, SPEC.name));
  if (existing) return existing.id;
  const [created] = await db
    .insert(applications)
    .values({ slug: SPEC.name, name: SPEC.name, appSpec: SPEC })
    .returning({ id: applications.id });
  return created!.id;
}

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
  const address = (await exec(session, "hostname -i 2>/dev/null | awk '{print $1}'")).stdout.trim();
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(address)) throw new Error(`${ref} : adresse illisible`);
  const ctx: DriverContext = {
    spec: SPEC,
    target: {
      id: found.id,
      name: found.name,
      host: found.host,
      rootPath: process.env.DRIVER_ROOT_PATH ?? '/opt/bootstrap',
    },
    deployment: { id: `npm-${runtime}-${Date.now()}`, version: SPEC.version, sequence: 1 },
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
  return {
    runtime,
    driver: getDriver(runtime),
    ctx,
    session,
    address,
    hostname: `${runtime}.${DOMAIN}`,
  };
}

async function appRange(side: Side): Promise<{ min: number; max: number }> {
  if (side.ctx.portRange) return side.ctx.portRange;
  const report = await getTargetPortReport(side.ctx.target.id);
  return report?.range ?? { min: 30000, max: 32767 };
}

function npmAddress(): string {
  return execFileSync('docker', [
    'inspect',
    '-f',
    '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
    'pupitre-npm-proxy-1',
  ])
    .toString()
    .trim();
}

async function declareDomain(host: string, address: string): Promise<void> {
  await fetch(`${CHALLTESTSRV}/add-a`, {
    method: 'POST',
    body: JSON.stringify({ host, addresses: [address] }),
  });
}

async function forgetDomain(host: string): Promise<void> {
  await fetch(`${CHALLTESTSRV}/clear-a`, { method: 'POST', body: JSON.stringify({ host }) }).catch(
    () => undefined,
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

const tls = (hostname: string): ProxyRoute => ({
  hostname,
  tls: true,
  redirectHttps: true,
  waf: 'block',
});

// ─── le déroulé ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const [dockerRef, k3sRef] = process.argv.slice(2);
  if (!dockerRef || !k3sRef) {
    write('Usage : pnpm test:npm <cible-docker> <cible-k3s>\n');
    process.exit(1);
  }
  write(bold('Nginx Proxy Manager — un proxy distant, piloté par son API\n'));

  // 0. L'instance et le compte de Pupitre.
  write(`\n${bold('── 0. l’instance')}\n`);
  const admin = await login(ADMIN.email, ADMIN.password);
  const accountId = await ensurePupitreAccount(admin);
  record('npm', 'compte de Pupitre aux droits restreints', true, PUPITRE.email);
  const npmIp = npmAddress();

  const provider = getRemoteProxyProvider('npm');
  const ctx: RemoteProxyContext = {
    config: { url: NPM_URL, email: PUPITRE.email, entrypoint: ENTRYPOINT },
    secrets: { password: PUPITRE.password },
  };
  const origin: ReachOrigin = {
    name: 'NPM de test',
    routeSource: async () => undefined,
    connect: (address, port, token) => provider.reach(ctx, { address, port, token }, log),
  };

  // 1. « Tester ».
  write(`\n${bold('── 1. la connexion')}\n`);
  const check = await provider.check(ctx, log);
  record(
    'npm',
    '« Tester » passe',
    check.ok,
    check.checks.map((item) => `${item.label} : ${item.detail}`).join(' · '),
  );
  const refused = await provider.check({ ...ctx, secrets: { password: 'faux' } }, log);
  const login1 = refused.checks.find((item) => item.key === 'login');
  record(
    'npm',
    'un mauvais mot de passe est refusé, en le disant',
    !refused.ok && login1?.ok === false && /identifiants refusés/.test(login1.detail ?? ''),
    login1?.detail ?? '',
  );

  const applicationId = await ensureApplication();
  const sides = [
    await openSide('docker', dockerRef, applicationId),
    await openSide('k3s', k3sRef, applicationId),
  ];
  const scope = (side: Side) => `t${side.ctx.target.id.slice(0, 8)}`;
  const foreignHost = `autre.${DOMAIN}`;
  const jokerHost = `app.joker.${DOMAIN}`;
  let foreignId: number | null = null;
  let jokerId: number | null = null;
  const work = mkdtempSync(path.join(tmpdir(), 'pupitre-npm-'));

  try {
    // 2. La liaison, à travers NPM.
    write(`\n${bold('── 2. la liaison, éprouvée à travers NPM')}\n`);
    const reached = new Map<RuntimeKind, string | null>();
    const ports = new Map<RuntimeKind, number>();
    for (const side of sides) {
      const report = await getTargetPortReport(side.ctx.target.id);
      const range = await appRange(side);
      const result = await guarded(side.runtime, 'connexion éprouvée', () =>
        checkReach({
          origin,
          served: side.ctx,
          address: side.address,
          portRange: range,
          reserved: new Set(report?.allocations.map((allocation) => allocation.port) ?? []),
          onLog: log,
        }),
      );
      if (!result) continue;
      reached.set(side.runtime, reachSource(result));
      // L'arrivée se relève avec python3 ou perl sur la machine servie ; avec
      // `nc` seul (une Alpine), elle ne l'est pas — et le résultat doit le dire.
      const source = reachSource(result);
      record(
        side.runtime,
        `NPM joint ${side.ctx.target.name} à ${side.address}`,
        result.ok === true &&
          (source === npmIp || (source === null && /n'a pas pu être relevé/.test(result.detail))),
        `${result.detail}${source ? ` — arrivée depuis ${source}` : ''}`,
      );
    }
    const firstRange = await appRange(sides[0]!);
    const nowhere = await guarded('npm', 'adresse injoignable', () =>
      checkReach({
        origin,
        served: sides[0]!.ctx,
        address: '192.0.2.1',
        portRange: firstRange,
      }),
    );
    if (nowhere) {
      record(
        'npm',
        'une adresse qui ne mène nulle part est dite telle',
        nowhere.ok === false && nowhere.failure === 'timeout',
        nowhere.detail,
      );
    }
    const leftovers = (await npm<Host[]>(admin, 'GET', '/nginx/proxy-hosts')).filter(
      (host) => (host.meta.pupitre as { reach?: boolean } | undefined)?.reach,
    );
    record('npm', 'aucun hôte de test ne reste', leftovers.length === 0, `${leftovers.length}`);

    // 3. Une application par runtime, et son domaine.
    write(`\n${bold('── 3. un domaine par runtime, HTTPS compris')}\n`);
    for (const side of sides) {
      const port = await guarded(side.runtime, 'déploiement', async () => {
        side.ctx.exposure = {
          byPort: true,
          bindAddress: side.address,
          ...(reached.get(side.runtime) ? { allowFrom: reached.get(side.runtime)! } : {}),
        };
        const allocated = await side.driver.allocatePort(side.ctx);
        const artifacts = await side.driver.render(side.ctx);
        await side.driver.upload(side.ctx, artifacts, () => {});
        await side.driver.build(side.ctx, () => {});
        const result = await side.driver.deploy(side.ctx, () => {});
        const health = await side.driver.healthcheck(side.ctx);
        if (!health.healthy) throw new Error(`en mauvaise santé : ${health.detail ?? ''}`);
        return result.publishedPort ?? allocated;
      });
      if (port === null) continue;
      ports.set(side.runtime, port);
      const upstream = side.driver.upstream(side.ctx, port);
      if (upstream?.kind !== 'port') {
        record(side.runtime, 'un port publié pour NPM', false, JSON.stringify(upstream));
        continue;
      }
      await declareDomain(side.hostname, npmIp);
      const applied = await guarded(side.runtime, 'apply()', async () => {
        await provider.apply(
          ctx,
          {
            appSlug: SPEC.name,
            scope: scope(side),
            routes: [tls(side.hostname)],
            upstream: { ...upstream, host: side.address },
          },
          log,
        );
        return true;
      });
      if (!applied) continue;
      const probe = await probeUntil(
        () => provider.probe(ctx, tls(side.hostname), '/'),
        (result) => result.ok && result.certificate.status === 'valid',
        60,
      );
      record(
        side.runtime,
        `${side.hostname} : HTTP → HTTPS, certificat de Pebble`,
        probe.ok &&
          [301, 308].includes(probe.http ?? 0) &&
          probe.https === 200 &&
          probe.certificate.status === 'valid' &&
          /Pebble/i.test(probe.certificate.issuer ?? ''),
        `${probe.detail} — ${probe.certificate.issuer ?? 'sans certificat'}`,
      );
    }

    // 3 bis. Deux demandes de certificat en même temps : NPM ne lance qu'un
    // certbot à la fois et refuse le second — Pupitre les fait passer l'une
    // après l'autre.
    const docker = sides[0]!;
    const shared = docker.driver.upstream(docker.ctx, ports.get('docker') ?? null);
    if (shared?.kind === 'port') {
      const twins = ['un', 'deux'].map((name) => ({
        appSlug: `${SPEC.name}-${name}`,
        hostname: `${name}.${DOMAIN}`,
      }));
      for (const twin of twins) await declareDomain(twin.hostname, npmIp);
      await Promise.all(
        twins.map((twin) =>
          provider
            .apply(
              ctx,
              {
                appSlug: twin.appSlug,
                scope: scope(docker),
                routes: [tls(twin.hostname)],
                upstream: { ...shared, host: docker.address },
              },
              log,
            )
            .catch(() => undefined),
        ),
      );
      const probes = await Promise.all(
        twins.map((twin) =>
          probeUntil(
            () => provider.probe(ctx, tls(twin.hostname), '/'),
            (result) => result.ok && result.certificate.status === 'valid',
            30,
          ),
        ),
      );
      record(
        'docker',
        'deux certificats demandés en même temps, deux obtenus',
        probes.every((probe) => probe.ok && probe.certificate.status === 'valid'),
        probes.map((probe) => probe.detail).join(' · '),
      );
      for (const twin of twins) {
        await provider.apply(
          ctx,
          { appSlug: twin.appSlug, scope: scope(docker), routes: [], upstream: null },
          log,
        );
        await forgetDomain(twin.hostname);
      }
    }

    // 4. Ce qui n'est pas à Pupitre.
    write(`\n${bold('── 4. ce qui n’est pas à Pupitre')}\n`);
    const dockerPort = docker.driver.upstream(docker.ctx, ports.get('docker') ?? null);
    foreignId = (
      await npm<Host>(admin, 'POST', '/nginx/proxy-hosts', {
        domain_names: [foreignHost],
        forward_scheme: 'http',
        forward_host: '192.0.2.10',
        forward_port: 8080,
      })
    ).id;
    const conflict = await provider
      .apply(
        ctx,
        {
          appSlug: SPEC.name,
          scope: scope(docker),
          routes: [tls(docker.hostname), { ...tls(foreignHost), tls: false }],
          upstream: dockerPort?.kind === 'port' ? { ...dockerPort, host: docker.address } : null,
        },
        log,
      )
      .then(() => null)
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
    record(
      'npm',
      'le domaine d’un autre compte, réclamé, est refusé en le disant',
      conflict !== null && /existe déjà dans NPM/.test(conflict),
      conflict ?? 'accepté',
    );
    // NPM recharge nginx après chaque geste : la sonde réessaie, comme celle du pipeline.
    const still = await probeUntil(
      () => provider.probe(ctx, tls(docker.hostname), '/'),
      (result) => result.ok,
      30,
    );
    record('docker', 'son propre domaine n’en souffre pas', still.ok, still.detail);

    // 5. Un joker déjà dans NPM.
    write(`\n${bold('── 5. un certificat déjà présent est repris')}\n`);
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-days',
        '30',
        '-subj',
        `/CN=*.joker.${DOMAIN}`,
        '-addext',
        `subjectAltName=DNS:*.joker.${DOMAIN}`,
        '-keyout',
        path.join(work, 'key.pem'),
        '-out',
        path.join(work, 'cert.pem'),
      ],
      { stdio: 'ignore' },
    );
    const pupitreToken = await login(PUPITRE.email, PUPITRE.password);
    jokerId = (
      await npm<Certificate>(pupitreToken, 'POST', '/nginx/certificates', {
        provider: 'other',
        nice_name: 'joker de test',
      })
    ).id;
    const form = new FormData();
    form.append('certificate', new Blob([readFileSync(path.join(work, 'cert.pem'))]), 'cert.pem');
    form.append('certificate_key', new Blob([readFileSync(path.join(work, 'key.pem'))]), 'key.pem');
    await npm(pupitreToken, 'POST', `/nginx/certificates/${jokerId}/upload`, form);
    const k3s = sides[1]!;
    const k3sPort = k3s.driver.upstream(k3s.ctx, ports.get('k3s') ?? null);
    const lines: string[] = [];
    await guarded('k3s', 'apply() avec le joker', () =>
      provider.apply(
        ctx,
        {
          appSlug: SPEC.name,
          scope: scope(k3s),
          routes: [tls(k3s.hostname), tls(jokerHost)],
          upstream: k3sPort?.kind === 'port' ? { ...k3sPort, host: k3s.address } : null,
        },
        (line) => {
          lines.push(line);
          log(line);
        },
      ),
    );
    const jokerProbe = await probeUntil(
      () => provider.probe(ctx, tls(jokerHost), '/'),
      (result) => result.ok,
      30,
    );
    record(
      'k3s',
      `${jokerHost} sert le joker, sans nouvelle demande`,
      jokerProbe.ok &&
        /\*\.joker/.test(jokerProbe.certificate.subject ?? '') &&
        lines.some((line) => line.includes('reprend le certificat')) &&
        !lines.some((line) => line.includes(`demande d'un certificat pour ${jokerHost}`)),
      `${jokerProbe.detail} — ${jokerProbe.certificate.subject ?? '?'}`,
    );

    // 6. Le retrait.
    write(`\n${bold('── 6. le retrait')}\n`);
    await provider.apply(
      ctx,
      { appSlug: SPEC.name, scope: scope(docker), routes: [], upstream: null },
      log,
    );
    let hosts = await npm<Host[]>(admin, 'GET', '/nginx/proxy-hosts');
    let certificates = await npm<Certificate[]>(admin, 'GET', '/nginx/certificates');
    record(
      'docker',
      'ses hôtes et son certificat partent ; ceux de K3s restent',
      !hosts.some((host) => host.domain_names.includes(docker.hostname)) &&
        !certificates.some((certificate) => certificate.domain_names.includes(docker.hostname)) &&
        hosts.some((host) => host.domain_names.includes(k3s.hostname)),
      hosts.map((host) => host.domain_names[0]).join(', '),
    );
    await provider.apply(
      ctx,
      { appSlug: SPEC.name, scope: scope(k3s), routes: [], upstream: null },
      log,
    );
    hosts = await npm<Host[]>(admin, 'GET', '/nginx/proxy-hosts');
    certificates = await npm<Certificate[]>(admin, 'GET', '/nginx/certificates');
    record(
      'k3s',
      'ses hôtes partent ; le joker et l’hôte de l’autre compte restent',
      !hosts.some((host) => (host.meta.pupitre as object | undefined) !== undefined) &&
        certificates.some((certificate) => certificate.id === jokerId) &&
        !certificates.some((certificate) => certificate.domain_names.includes(k3s.hostname)) &&
        hosts.some((host) => host.id === foreignId),
      `${hosts.length} hôte(s), ${certificates.length} certificat(s)`,
    );
  } finally {
    write(`\n${dim('ménage…')}\n`);
    for (const side of sides) {
      await side.driver.destroy(side.ctx, () => {}).catch(() => undefined);
      await disconnect(side.session);
      await forgetDomain(side.hostname);
    }
    await forgetDomain(jokerHost);
    if (foreignId !== null) {
      await npm(admin, 'DELETE', `/nginx/proxy-hosts/${foreignId}`).catch(() => undefined);
    }
    if (jokerId !== null) {
      await npm(admin, 'DELETE', `/nginx/certificates/${jokerId}`).catch(() => undefined);
    }
    // Ce que le compte de Pupitre aurait laissé en cas d'échec, puis le compte.
    const pupitreToken = await login(PUPITRE.email, PUPITRE.password).catch(() => null);
    if (pupitreToken) {
      for (const host of await npm<Host[]>(pupitreToken, 'GET', '/nginx/proxy-hosts')) {
        await npm(pupitreToken, 'DELETE', `/nginx/proxy-hosts/${host.id}`).catch(() => undefined);
      }
      for (const cert of await npm<Certificate[]>(pupitreToken, 'GET', '/nginx/certificates')) {
        await npm(pupitreToken, 'DELETE', `/nginx/certificates/${cert.id}`).catch(() => undefined);
      }
    }
    await npm(admin, 'DELETE', `/users/${accountId}`).catch(() => undefined);
    await getDb().delete(applications).where(eq(applications.id, applicationId));
    rmSync(work, { recursive: true, force: true });
  }

  await closeDb();
  write(`\n  ${passes} vérification(s) au vert, ${failures} en échec\n`);
  write(failures === 0 ? green(bold('\nNPM tient.\n')) : red(bold('\nÉchec.\n')));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error: unknown) => {
  write(red(`\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`));
  await closeDb().catch(() => undefined);
  process.exit(1);
});
