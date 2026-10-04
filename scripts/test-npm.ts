/**
 * Nginx Proxy Manager end to end — a **remote** proxy, driven through its API.
 *
 *   docker compose --profile test up -d pebble pebble-dns npm-proxy
 *   pnpm test:npm <docker-target> <k3s-target>
 *
 * Against a real instance (2.16), with an account with restricted rights:
 *   0. the instance answers; its administrator creates Pupitre's account —
 *      "Manage" on Proxy Hosts and SSL Certificates, "Created Items"
 *      visibility;
 *   1. "Test" passes; a wrong password is refused, saying so;
 *   2. the link, tried out **through NPM** to each target (`checkReach`), the
 *      arrival recorded; an address that leads nowhere is called so, and no
 *      test host remains;
 *   3. on each runtime, an application published for NPM alone and its domain
 *      set: HTTP redirects to HTTPS, certificate issued by Pebble, probed from
 *      the panel;
 *   4. what does not belong to Pupitre stays: another account's host is not
 *      touched, and its domain, claimed, is refused, saying so;
 *   5. a certificate already in NPM that covers the domain (a wildcard) is
 *      taken over;
 *   6. the removal: Pupitre's hosts go with its certificates; the wildcard and
 *      the other account's host stay; one machine does not touch the other.
 * Then everything is removed: applications, hosts, certificates, account, test DNS.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseAppSpec } from '@pupitre/core';
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
import { disconnect, exec, type SshSession } from '@pupitre/core/ssh';
import {
  applications,
  closeDb,
  createPortAllocator,
  eq,
  getDb,
  getTargetPortReport,
} from '@pupitre/db';
import { bold, createReport, dim, red, write } from './lib/report.js';
import { ensureApplication, openTarget, portRangeFromEnv } from './lib/targets.js';

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

const log = (line: string) => write(`    ${dim(line)}\n`);

const report = createReport();
const { record } = report;

async function guarded<T>(scope: string, label: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    record(scope, label, false, error instanceof Error ? error.message : String(error));
    return null;
  }
}

const SPEC = parseAppSpec({
  name: 'npm-trial',
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

// ─── the NPM instance, administrator side ────────────────────────────────────

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
  if (!response.ok) throw new Error(`${method} ${route}: HTTP ${response.status} ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

async function login(email: string, password: string): Promise<string> {
  const answer = await npm<{ token: string }>(null, 'POST', '/tokens', {
    identity: email,
    secret: password,
  });
  return answer.token;
}

/** Pupitre's account, as the documentation advises. */
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

// ─── the targets ─────────────────────────────────────────────────────────────

type Side = {
  runtime: RuntimeKind;
  driver: DeploymentDriver;
  ctx: DriverContext;
  session: SshSession;
  address: string;
  hostname: string;
};

async function openSide(runtime: RuntimeKind, ref: string, applicationId: string): Promise<Side> {
  const { session, target: found } = await openTarget(ref);
  const address = (await exec(session, "hostname -i 2>/dev/null | awk '{print $1}'")).stdout.trim();
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(address)) throw new Error(`${ref}: unreadable address`);
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
    language: 'fr',
    appSlug: SPEC.name,
    applicationId,
    portAllocator: createPortAllocator(),
    ...portRangeFromEnv(),
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

// ─── the run ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const [dockerRef, k3sRef] = process.argv.slice(2);
  if (!dockerRef || !k3sRef) {
    write('Usage: pnpm test:npm <docker-target> <k3s-target>\n');
    process.exit(1);
  }
  write(bold('Nginx Proxy Manager — a remote proxy, driven through its API\n'));

  // 0. The instance and Pupitre's account.
  write(`\n${bold('── 0. the instance')}\n`);
  const admin = await login(ADMIN.email, ADMIN.password);
  const accountId = await ensurePupitreAccount(admin);
  record('npm', "Pupitre's account with restricted rights", true, PUPITRE.email);
  const npmIp = npmAddress();

  const provider = getRemoteProxyProvider('npm');
  const ctx: RemoteProxyContext = {
    config: { url: NPM_URL, email: PUPITRE.email, entrypoint: ENTRYPOINT },
    secrets: { password: PUPITRE.password },
    language: 'fr',
  };
  const origin: ReachOrigin = {
    name: 'Test NPM',
    routeSource: async () => undefined,
    connect: (address, port, token) => provider.reach(ctx, { address, port, token }, log),
  };

  // 1. "Test".
  write(`\n${bold('── 1. the connection')}\n`);
  const check = await provider.check(ctx, log);
  record(
    'npm',
    '"Test" passes',
    check.ok,
    check.checks.map((item) => `${item.label}: ${item.detail}`).join(' · '),
  );
  const refused = await provider.check({ ...ctx, secrets: { password: 'wrong' } }, log);
  const login1 = refused.checks.find((item) => item.key === 'login');
  record(
    'npm',
    'a wrong password is refused, saying so',
    !refused.ok && login1?.ok === false && /identifiants refusés/.test(login1.detail ?? ''),
    login1?.detail ?? '',
  );

  const applicationId = await ensureApplication(SPEC);
  const sides = [
    await openSide('docker', dockerRef, applicationId),
    await openSide('k3s', k3sRef, applicationId),
  ];
  const scope = (side: Side) => `t${side.ctx.target.id.slice(0, 8)}`;
  const foreignHost = `other.${DOMAIN}`;
  const wildcardHost = `app.wildcard.${DOMAIN}`;
  let foreignId: number | null = null;
  let wildcardId: number | null = null;
  const work = mkdtempSync(path.join(tmpdir(), 'pupitre-npm-'));

  try {
    // 2. The link, through NPM.
    write(`\n${bold('── 2. the link, tried out through NPM')}\n`);
    const reached = new Map<RuntimeKind, string | null>();
    const ports = new Map<RuntimeKind, number>();
    for (const side of sides) {
      const report = await getTargetPortReport(side.ctx.target.id);
      const range = await appRange(side);
      const result = await guarded(side.runtime, 'connection tried out', () =>
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
      // The arrival is recorded with python3 or perl on the served machine; with
      // `nc` alone (an Alpine), it is not — and the result must say so.
      const source = reachSource(result);
      record(
        side.runtime,
        `NPM reaches ${side.ctx.target.name} at ${side.address}`,
        result.ok === true &&
          (source === npmIp ||
            (source === null && /n['’]a pas pu être relevé/.test(result.detail))),
        `${result.detail}${source ? ` — arrival from ${source}` : ''}`,
      );
    }
    const firstRange = await appRange(sides[0]!);
    const nowhere = await guarded('npm', 'unreachable address', () =>
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
        'an address that leads nowhere is called so',
        nowhere.ok === false && nowhere.failure === 'timeout',
        nowhere.detail,
      );
    }
    const leftovers = (await npm<Host[]>(admin, 'GET', '/nginx/proxy-hosts')).filter(
      (host) => (host.meta.pupitre as { reach?: boolean } | undefined)?.reach,
    );
    record('npm', 'no test host remains', leftovers.length === 0, `${leftovers.length}`);

    // 3. One application per runtime, and its domain.
    write(`\n${bold('── 3. one domain per runtime, HTTPS included')}\n`);
    for (const side of sides) {
      const port = await guarded(side.runtime, 'deployment', async () => {
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
        if (!health.healthy) throw new Error(`unhealthy: ${health.detail ?? ''}`);
        return result.publishedPort ?? allocated;
      });
      if (port === null) continue;
      ports.set(side.runtime, port);
      const upstream = side.driver.upstream(side.ctx, port);
      if (upstream?.kind !== 'port') {
        record(side.runtime, 'a port published for NPM', false, JSON.stringify(upstream));
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
        `${side.hostname}: HTTP → HTTPS, Pebble certificate`,
        probe.ok &&
          [301, 308].includes(probe.http ?? 0) &&
          probe.https === 200 &&
          probe.certificate.status === 'valid' &&
          /Pebble/i.test(probe.certificate.issuer ?? ''),
        `${probe.detail} — ${probe.certificate.issuer ?? 'no certificate'}`,
      );
    }

    // 3 bis. Two certificate requests at the same time: NPM only runs one certbot
    // at a time and refuses the second — Pupitre makes them go one after the
    // other.
    const docker = sides[0]!;
    const shared = docker.driver.upstream(docker.ctx, ports.get('docker') ?? null);
    if (shared?.kind === 'port') {
      const twins = ['one', 'two'].map((name) => ({
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
        'two certificates requested at the same time, two obtained',
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

    // 4. What does not belong to Pupitre.
    write(`\n${bold('── 4. what does not belong to Pupitre')}\n`);
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
      "another account's domain, claimed, is refused, saying so",
      conflict !== null && /existe déjà dans NPM/.test(conflict),
      conflict ?? 'accepted',
    );
    // NPM reloads nginx after each gesture: the probe retries, like the pipeline's.
    const still = await probeUntil(
      () => provider.probe(ctx, tls(docker.hostname), '/'),
      (result) => result.ok,
      30,
    );
    record('docker', 'its own domain does not suffer from it', still.ok, still.detail);

    // 5. A wildcard already in NPM.
    write(`\n${bold('── 5. a certificate already present is taken over')}\n`);
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
        `/CN=*.wildcard.${DOMAIN}`,
        '-addext',
        `subjectAltName=DNS:*.wildcard.${DOMAIN}`,
        '-keyout',
        path.join(work, 'key.pem'),
        '-out',
        path.join(work, 'cert.pem'),
      ],
      { stdio: 'ignore' },
    );
    const pupitreToken = await login(PUPITRE.email, PUPITRE.password);
    wildcardId = (
      await npm<Certificate>(pupitreToken, 'POST', '/nginx/certificates', {
        provider: 'other',
        nice_name: 'test wildcard',
      })
    ).id;
    const form = new FormData();
    form.append('certificate', new Blob([readFileSync(path.join(work, 'cert.pem'))]), 'cert.pem');
    form.append('certificate_key', new Blob([readFileSync(path.join(work, 'key.pem'))]), 'key.pem');
    await npm(pupitreToken, 'POST', `/nginx/certificates/${wildcardId}/upload`, form);
    const k3s = sides[1]!;
    const k3sPort = k3s.driver.upstream(k3s.ctx, ports.get('k3s') ?? null);
    const lines: string[] = [];
    await guarded('k3s', 'apply() with the wildcard', () =>
      provider.apply(
        ctx,
        {
          appSlug: SPEC.name,
          scope: scope(k3s),
          routes: [tls(k3s.hostname), tls(wildcardHost)],
          upstream: k3sPort?.kind === 'port' ? { ...k3sPort, host: k3s.address } : null,
        },
        (line) => {
          lines.push(line);
          log(line);
        },
      ),
    );
    const wildcardProbe = await probeUntil(
      () => provider.probe(ctx, tls(wildcardHost), '/'),
      (result) => result.ok,
      30,
    );
    record(
      'k3s',
      `${wildcardHost} serves the wildcard, without a new request`,
      wildcardProbe.ok &&
        /\*\.wildcard/.test(wildcardProbe.certificate.subject ?? '') &&
        lines.some((line) => line.includes('reprend le certificat')) &&
        !lines.some((line) => line.includes(`demande d'un certificat pour ${wildcardHost}`)),
      `${wildcardProbe.detail} — ${wildcardProbe.certificate.subject ?? '?'}`,
    );

    // 6. The removal.
    write(`\n${bold('── 6. the removal')}\n`);
    await provider.apply(
      ctx,
      { appSlug: SPEC.name, scope: scope(docker), routes: [], upstream: null },
      log,
    );
    let hosts = await npm<Host[]>(admin, 'GET', '/nginx/proxy-hosts');
    let certificates = await npm<Certificate[]>(admin, 'GET', '/nginx/certificates');
    record(
      'docker',
      "its hosts and its certificate go; K3s's stay",
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
      "its hosts go; the wildcard and the other account's host stay",
      !hosts.some((host) => (host.meta.pupitre as object | undefined) !== undefined) &&
        certificates.some((certificate) => certificate.id === wildcardId) &&
        !certificates.some((certificate) => certificate.domain_names.includes(k3s.hostname)) &&
        hosts.some((host) => host.id === foreignId),
      `${hosts.length} host(s), ${certificates.length} certificate(s)`,
    );
  } finally {
    write(`\n${dim('cleanup…')}\n`);
    for (const side of sides) {
      await side.driver.destroy(side.ctx, () => {}).catch(() => undefined);
      await disconnect(side.session);
      await forgetDomain(side.hostname);
    }
    await forgetDomain(wildcardHost);
    if (foreignId !== null) {
      await npm(admin, 'DELETE', `/nginx/proxy-hosts/${foreignId}`).catch(() => undefined);
    }
    if (wildcardId !== null) {
      await npm(admin, 'DELETE', `/nginx/certificates/${wildcardId}`).catch(() => undefined);
    }
    // What Pupitre's account would have left in case of failure, then the account.
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
  report.summary('NPM holds.');
  process.exit(report.failures === 0 ? 0 : 1);
}

main().catch(async (error: unknown) => {
  write(red(`\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`));
  await closeDb().catch(() => undefined);
  process.exit(1);
});
