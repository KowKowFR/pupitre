/**
 * THE MOMENT OF TRUTH test of the architecture.
 *
 * A single AppSpec, two runtimes. If a field has to be changed between the two
 * deployments, the abstraction has failed and this script must say so.
 *
 *   pnpm test:parity <docker-target> <k3s-target> [--spec file.json] [--keep]
 *
 * Run:
 *   1. an application created from `parity.json`
 *   2. both targets opened
 *   3. the known limits named and excluded from the count
 *   4. deployed on the Docker target then, **same AppSpec, without a single
 *      change**, on the K3s target → each must answer 200 through the means its
 *      driver announced
 *   5. rollback of both             → both still answer
 *   6. destroy of both              → nothing runs any more, the Docker port is
 *      released, the K3s namespace is gone
 *
 * Exit code 1 as soon as a single point fails. A known limit is not a failure:
 * it is reported apart, with its reason — see `exclude()`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decrypt, parseAppSpec, type AppSpec, type Service } from '@pupitre/core';
import {
  getDriver,
  type DeploymentDriver,
  type DriverContext,
  type DriverDeployment,
  type RenderedFile,
  type RuntimeKind,
} from '@pupitre/core/drivers';
import {
  getProxyProvider,
  proxyCapabilities,
  type ProxyContext,
  type ProxyProvider,
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
  getProxyForTarget,
  getTargetSecret,
  listTargets,
} from '@pupitre/db';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Why `parity.json` and not `fullstack.json`.
 *
 * `fullstack.json` sets `front.replicas: 2` on the exposed service, which keeps
 * Docker from publishing a port: two containers cannot bind to the same one. It
 * stays the reference fixture for the rendering and the prompt; it is not the
 * one for the cross deployment.
 *
 * `parity.json` replaces it without removing anything of what is checked here:
 * four services linked by `dependsOn`, two volumes, two secrets including an
 * alias, a replication of 2 on a non-exposed service, a TLS ingress.
 *
 * And, since the K3s driver can build, **two of these services start from a
 * Dockerfile**: `front`, which is the entry door — so the URL that answers is
 * served by an image we made — and `api`, whose Dockerfile is in a
 * subdirectory (`docker/Dockerfile`) and which runs as two replicas. Port 8080
 * is not decorative: the images we build run as uid 1000 without
 * `CAP_NET_BIND_SERVICE`, and cannot bind below 1024.
 */
const DEFAULT_SPEC = path.join(ROOT, 'packages/core/src/spec/__fixtures__/parity.json');

const ESC = String.fromCharCode(27);
const paint = (code: string) => (text: string) => `${ESC}[${code}m${text}${ESC}[0m`;
const bold = paint('1');
const green = paint('32');
const red = paint('31');
const yellow = paint('33');
const dim = paint('2');

function write(text: string): void {
  process.stdout.write(text);
}
function step(title: string): void {
  write(`\n${bold(title)}\n`);
}
function info(message: string): void {
  write(`    ${dim(message)}\n`);
}

// ─── summary table ────────────────────────────────────────────────────────────

type Check = {
  phase: string;
  runtime: RuntimeKind | 'both';
  label: string;
  ok: boolean;
  detail: string;
};

const checks: Check[] = [];

/**
 * A capability a runtime does not have, and that this test **therefore does
 * not exercise**.
 *
 * It is neither a failure nor a silence: a limit is named, justified, and comes
 * out in the summary outside the count. A test made green by removing what it
 * checked is worth nothing; a test that says what it does not check, and why,
 * stays readable in six months.
 */
type Limitation = {
  runtime: RuntimeKind;
  label: string;
  reason: string;
  /** Where the decision is documented. */
  reference: string;
};

const limitations: Limitation[] = [];

function exclude(limitation: Limitation): void {
  limitations.push(limitation);
  write(`  ${yellow('N/A')} [${limitation.runtime}] ${limitation.label}\n`);
  write(`      ${dim(limitation.reason)}\n`);
  write(`      ${dim(limitation.reference)}\n`);
}

function record(check: Check): boolean {
  checks.push(check);
  write(
    `  ${check.ok ? green('OK') : red('KO')} [${check.runtime}] ${check.label}` +
      `${check.detail ? ` ${dim(`— ${check.detail}`)}` : ''}\n`,
  );
  return check.ok;
}

/** Runs a phase, turning an exception into a traced failure. */
async function guarded<T>(
  phase: string,
  runtime: RuntimeKind,
  label: string,
  run: () => Promise<T>,
): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    record({
      phase,
      runtime,
      label,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// ─── arguments ────────────────────────────────────────────────────────────────

type Options = {
  dockerTarget: string;
  k3sTarget: string;
  specPath: string;
  keep: boolean;
};

function parseArgs(argv: string[]): Options {
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  const specIndex = argv.indexOf('--spec');

  const [dockerTarget, k3sTarget] = positional;
  if (!dockerTarget || !k3sTarget) {
    write(
      'Usage: pnpm test:parity <docker-target> <k3s-target> [--spec file.json] [--keep]\n\n' +
        'Both targets are names or UUIDs of registered targets.\n',
    );
    process.exit(1);
  }

  return {
    dockerTarget,
    k3sTarget,
    specPath: specIndex === -1 ? DEFAULT_SPEC : (argv[specIndex + 1] ?? DEFAULT_SPEC),
    keep: argv.includes('--keep'),
  };
}

// ─── build contexts ────────────────────────────────────────────────────────────

/**
 * The Dockerfile services need their sources on the target. In production it
 * is the pipeline that provides them; here we make them, identically for both
 * runtimes — it is the whole point of the test.
 *
 * The image is deliberately minimal and **unprivileged**: it must hold under
 * the strict `securityContext` the K3s driver imposes (uid 1000, read-only
 * root) as well as under Docker Compose.
 */
function buildContexts(spec: AppSpec): RenderedFile[] {
  const files: RenderedFile[] = [];

  for (const service of spec.services) {
    if (service.source.type !== 'dockerfile') continue;

    const context = service.source.context.replace(/^\.\//, '').replace(/\/$/, '');

    files.push({
      path: `${context}/${service.source.dockerfile}`,
      content: dockerfileFor(service),
      mode: 0o644,
    });
  }

  return files;
}

function dockerfileFor(service: Service): string {
  const probePath = service.healthcheck.path;
  // A probe path ending with `/` designates a directory: it is `index.html` that
  // answers there, and trying to write a file there would make the build fail on
  // "can't create /www/: Is a directory".
  const probeFile = probePath.endsWith('/') ? null : `/www${probePath}`;
  const directory = probeFile ? probeFile.slice(0, probeFile.lastIndexOf('/')) : '/www';

  return [
    '# Synthetic build context, produced by scripts/test-parity.ts.',
    `# Service "${service.name}" — listens on ${service.port}, answers on ${probePath}.`,
    'FROM busybox:1.36',
    `RUN mkdir -p ${directory} \\`,
    ...(probeFile ? [`  && printf 'ok\\n' > ${probeFile} \\`] : []),
    `  && printf '<h1>${service.name}</h1>\\n' > /www/index.html`,
    // uid 1000: the K3s driver imposes this identity on the images it builds. The
    // Dockerfile must carry it, otherwise the kubelet refuses to start a container
    // whose image declares `root` under `runAsNonRoot`.
    'USER 1000:1000',
    `EXPOSE ${service.port}`,
    `CMD ["httpd", "-f", "-v", "-p", "${service.port}", "-h", "/www"]`,
    '',
  ].join('\n');
}

// ─── infrastructure ───────────────────────────────────────────────────────────

/** An `applications` row is required: `port_allocations` references it. */
async function ensureApplication(spec: AppSpec): Promise<string> {
  const db = getDb();
  const [existing] = await db.select().from(applications).where(eq(applications.slug, spec.name));

  if (existing) {
    await db
      .update(applications)
      .set({ appSpec: spec, name: spec.name, updatedAt: new Date() })
      .where(eq(applications.id, existing.id));
    return existing.id;
  }

  const [created] = await db
    .insert(applications)
    .values({ slug: spec.name, name: spec.name, appSpec: spec })
    .returning({ id: applications.id });

  if (!created) throw new Error('inserting the application returned nothing');
  return created.id;
}

type Side = {
  runtime: RuntimeKind;
  driver: DeploymentDriver;
  ctx: DriverContext;
  session: SshSession;
  targetName: string;
  targetHost: string;
  /** Filled in by the deployment phase. */
  url: string | null;
  publishedPort: number | null;
  /**
   * The target's reverse proxy, when it has one and the spec has a domain: the
   * route is then set and tried out as the pipeline does it.
   */
  proxy: { provider: ProxyProvider; ctx: ProxyContext; route: ProxyRoute } | null;
};

async function openSide(
  runtime: RuntimeKind,
  targetRef: string,
  spec: AppSpec,
  applicationId: string,
  additionalFiles: RenderedFile[],
): Promise<Side> {
  const all = await listTargets();
  const found = all.find(
    (candidate) => candidate.id === targetRef || candidate.name === targetRef,
  );
  if (!found) {
    throw new Error(
      `Target "${targetRef}" not found. Known targets: ` +
        (all.map((target) => target.name).join(', ') || 'none'),
    );
  }

  const record_ = await getTargetSecret(found.id);
  if (!record_) throw new Error(`Could not read target ${found.id} again`);

  const secret = decrypt(record_.encryptedCredential);
  const sshTarget: SshTarget = {
    host: record_.target.host,
    port: record_.target.port,
    username: record_.target.sshUser,
    sudoMethod: record_.target.sudoMethod,
    credentials:
      record_.target.authMethod === 'key'
        ? { authMethod: 'key', privateKey: secret }
        : { authMethod: 'password', password: secret },
  };

  const session = await connect(sshTarget, { language: 'en' });
  const deployment: DriverDeployment = {
    id: `parity-${runtime}-${Date.now()}`,
    version: spec.version,
    sequence: 1,
  };

  const ctx: DriverContext = {
    spec,
    target: {
      id: found.id,
      name: found.name,
      host: found.host,
      rootPath: process.env.DRIVER_ROOT_PATH ?? '/opt/bootstrap',
    },
    deployment,
    sshSession: session,
    language: 'en',
    appSlug: spec.name,
    applicationId,
    // This script only deploys once: the rollback brings back this same release —
    // it is the gesture it tries out, on both runtimes.
    previousDeployment: deployment,
    portAllocator: createPortAllocator(),
    /**
     * Filler values for the declared secrets.
     *
     * This script drives the drivers directly: it has neither an application in
     * the database nor a secrets store. Yet the rendering now refuses a secret
     * declared without a value — rightly, it is what keeps an empty `.env` from
     * leaving for a machine. Here the value does not matter at all: we compare two
     * runtimes, not the secrets' resolution. Both sides get the same one, which
     * makes the comparison more straightforward, by the way.
     */
    resolveSecrets: (names) =>
      Promise.resolve(
        Object.fromEntries(names.map((name) => [name, `parity-value-${name.toLowerCase()}`])),
      ),
    additionalFiles,
    ...(process.env.DRIVER_PORT_RANGE
      ? {
          portRange: (() => {
            const [min, max] = process.env.DRIVER_PORT_RANGE.split('-').map(Number);
            return { min: min ?? 30_000, max: max ?? 32_767 };
          })(),
        }
      : {}),
  };

  // The spec's domain goes through the target's proxy, if there is one — and, as
  // in the pipeline, the port is then only published where the proxy reaches it.
  const proxyRecord = await getProxyForTarget(found.id);
  const host = spec.ingress?.host;
  let proxy: Side['proxy'] = null;
  if (proxyRecord && host) {
    const provider = getProxyProvider(proxyRecord.kind);
    const tls =
      (spec.ingress?.tls ?? false) && proxyCapabilities(proxyRecord.kind, proxyRecord.config).https;
    proxy = {
      provider,
      ctx: { ...ctx, config: proxyRecord.config },
      route: { hostname: host, tls, redirectHttps: tls, waf: 'block' },
    };
    const address = provider.publishAddress(proxyRecord.config);
    if (address) ctx.exposure = { bindAddress: address };
  }

  return {
    runtime,
    driver: getDriver(runtime),
    ctx,
    session,
    targetName: found.name,
    targetHost: found.host,
    url: null,
    publishedPort: null,
    proxy,
  };
}

/**
 * The URL, through the reverse proxy: the route of the spec's domain, set on the
 * target's proxy toward the upstream the driver announces, then tried out from
 * the target. It is a visitor's path — and the same for both runtimes.
 */
async function probeThroughProxy(side: Side, probePath: string): Promise<RouteProbe> {
  const proxy = side.proxy!;
  let probe = await proxy.provider.probe(proxy.ctx, proxy.route, probePath);
  for (let attempt = 1; attempt < 10 && !probe.ok; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    probe = await proxy.provider.probe(proxy.ctx, proxy.route, probePath);
  }
  return probe;
}

async function urlCheck(side: Side, probePath: string): Promise<{ ok: boolean; detail: string }> {
  if (side.proxy) {
    const probe = await probeThroughProxy(side, probePath);
    return {
      ok: probe.ok,
      detail: `${side.proxy.route.hostname} through the proxy — ${probe.detail}`,
    };
  }
  const probe = await probeFromTarget(side, probePath);
  return {
    ok: probe.status !== null && probe.status >= 200 && probe.status < 400,
    detail: probe.status === null ? probe.detail : `HTTP ${probe.status} — ${probe.detail}`,
  };
}

// ─── sonde HTTP ───────────────────────────────────────────────────────────────

/**
 * Probes the application **from the target**, the only place from which it is
 * reachable for sure: the workstation running this script has neither the
 * application's DNS nor a route to the cluster's internal network.
 *
 * The path without a reverse proxy: the port published by the driver, what it
 * **really** opened on the machine. When the target has a proxy, it is
 * `probeThroughProxy()` that probes, through the domain — see `urlCheck()`. A
 * K3s target without a proxy has nothing to probe here: `allocatePort()`
 * answered `null`, and the Service is only reachable inside the cluster.
 */
async function probeFromTarget(
  side: Side,
  probePath: string,
): Promise<{ status: number | null; detail: string }> {
  const url =
    side.publishedPort !== null ? `http://127.0.0.1:${side.publishedPort}` : side.url;
  if (!url) {
    return { status: null, detail: 'the driver announced neither a published port nor a URL' };
  }

  const parsed = new URL(url);
  const target = new URL(probePath, parsed).toString();
  const isName = !/^\d+\.\d+\.\d+\.\d+$/.test(parsed.hostname) && parsed.hostname !== 'localhost';
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');

  // `--resolve`: the AppSpec's domain name has no reason to exist in the target's
  // DNS. We pin it on the loopback, where the proxy (Traefik on Docker, ingress
  // controller on K3s) listens.
  const resolve = isName ? `--resolve '${parsed.hostname}:${port}:127.0.0.1' ` : '';
  const command = `curl -s -k -o /dev/null -w '%{http_code}' -m 15 ${resolve}'${target}'`;

  const via =
    side.publishedPort !== null
      ? `published port ${side.publishedPort}`
      : `announced URL ${parsed.origin}`;

  const result = await exec(side.session, command, { timeout: 30_000 });
  const status = Number.parseInt(result.stdout.trim().split('\n').pop() ?? '', 10);
  const ok = !Number.isNaN(status) && status !== 0;

  return {
    status: ok ? status : null,
    detail: ok ? `${via} — ${target}` : `${via} — ${command}`,
  };
}

// ─── phases ───────────────────────────────────────────────────────────────────

async function deploySide(side: Side, probePath: string): Promise<void> {
  const { driver, ctx, runtime } = side;
  const emit = (line: string) => write(`      ${dim(line)}\n`);

  const preflight = await guarded('deploy', runtime, 'preflight()', () => driver.preflight(ctx));
  if (!preflight) return;
  for (const check of preflight.checks) {
    info(`${check.ok ? '✓' : '✗'} ${check.label} — ${check.detail ?? ''}`);
  }
  if (
    !record({
      phase: 'deploy',
      runtime,
      label: 'preflight()',
      ok: preflight.ok,
      detail: preflight.runtimeVersion ?? '',
    })
  ) {
    return;
  }

  // The only expected gap between the two runtimes, and it comes from the
  // driver. `guarded` returns `null` on an exception: the answer is wrapped so
  // as not to confuse "the driver answered null" and "the driver failed".
  const allocation = await guarded('deploy', runtime, 'allocatePort()', async () => ({
    port: await driver.allocatePort(ctx),
  }));
  if (!allocation) return;
  side.publishedPort = allocation.port;
  record({
    phase: 'deploy',
    runtime,
    label: 'allocatePort()',
    ok: true,
    detail:
      allocation.port === null
        ? 'null — exposure through Ingress, the step would be "skipped"'
        : `port ${allocation.port} reserved`,
  });

  const artifacts = await guarded('deploy', runtime, 'render()', () => driver.render(ctx));
  if (!artifacts) return;
  record({
    phase: 'deploy',
    runtime,
    label: 'render()',
    ok: artifacts.files.length > 0,
    detail: `${artifacts.projectName} — ${artifacts.files.length} file(s)`,
  });
  for (const file of artifacts.files) info(`${file.path} — ${file.content.length} bytes`);

  const uploaded = await guarded('deploy', runtime, 'upload()', async () => {
    await driver.upload(ctx, artifacts, emit);
    return true;
  });
  if (!uploaded) return;
  record({ phase: 'deploy', runtime, label: 'upload()', ok: true, detail: '' });

  const built = await guarded('deploy', runtime, 'build()', async () => ({
    images: await driver.build(ctx, emit),
  }));
  if (!built) return;
  record({
    phase: 'deploy',
    runtime,
    label: 'build()',
    ok: true,
    detail:
      built.images === null
        ? 'nothing to build — the step would be "skipped"'
        : built.images.join(', '),
  });

  const result = await guarded('deploy', runtime, 'deploy()', () => driver.deploy(ctx, emit));
  if (!result) return;
  side.url = result.url;
  side.publishedPort = result.publishedPort ?? side.publishedPort;
  record({
    phase: 'deploy',
    runtime,
    label: 'deploy()',
    ok: result.ok,
    detail: result.url ?? 'no public URL',
  });

  const health = await guarded('deploy', runtime, 'healthcheck()', () => driver.healthcheck(ctx));
  record({
    phase: 'deploy',
    runtime,
    label: 'healthcheck()',
    ok: health?.healthy === true,
    detail: health?.detail ?? 'no detail',
  });

  if (side.proxy) {
    const proxy = side.proxy;
    const applied = await guarded('deploy', runtime, 'route set on the proxy', async () => {
      await proxy.provider.apply(
        proxy.ctx,
        {
          appSlug: ctx.appSlug,
          routes: [proxy.route],
          upstream: driver.upstream(ctx, side.publishedPort),
        },
        emit,
      );
      return true;
    });
    if (!applied) return;
    record({
      phase: 'deploy',
      runtime,
      label: 'route set on the proxy',
      ok: true,
      detail: proxy.route.hostname,
    });
  }

  const url = await urlCheck(side, probePath);
  record({ phase: 'deploy', runtime, label: 'the URL answers', ok: url.ok, detail: url.detail });
}

async function rollbackSide(side: Side, probePath: string): Promise<void> {
  const { driver, ctx, runtime } = side;
  const emit = (line: string) => write(`      ${dim(line)}\n`);

  const done = await guarded('rollback', runtime, 'rollback()', async () => {
    await driver.rollback(ctx, emit);
    return true;
  });
  if (!done) return;
  record({ phase: 'rollback', runtime, label: 'rollback()', ok: true, detail: '' });

  const health = await guarded('rollback', runtime, 'health after rollback', () =>
    driver.healthcheck(ctx),
  );
  record({
    phase: 'rollback',
    runtime,
    label: 'health after rollback',
    ok: health?.healthy === true,
    detail: health?.detail ?? 'no detail',
  });

  const url = await urlCheck(side, probePath);
  record({
    phase: 'rollback',
    runtime,
    label: 'the URL still answers',
    ok: url.ok,
    detail: url.detail,
  });
}

async function destroySide(side: Side): Promise<void> {
  const { driver, ctx, runtime } = side;
  const emit = (line: string) => write(`      ${dim(line)}\n`);

  if (side.proxy) {
    const proxy = side.proxy;
    await guarded('destroy', runtime, 'route removed from the proxy', () =>
      proxy.provider.apply(
        proxy.ctx,
        { appSlug: ctx.appSlug, routes: [], upstream: driver.upstream(ctx, side.publishedPort) },
        emit,
      ),
    );
  }
  const done = await guarded('destroy', runtime, 'destroy()', async () => {
    await driver.destroy(ctx, emit);
    return true;
  });
  if (!done) return;
  record({ phase: 'destroy', runtime, label: 'destroy()', ok: true, detail: '' });

  const appPath = `${ctx.target.rootPath}/apps/${ctx.appSlug}`;
  const leftovers = await exec(side.session, `test -d '${appPath}'`, { timeout: 30_000 });
  record({
    phase: 'destroy',
    runtime,
    label: 'artifacts deleted from the target',
    ok: leftovers.code !== 0,
    detail: appPath,
  });

  const allocated = await ctx.portAllocator?.current({
    targetId: ctx.target.id,
    applicationId: ctx.applicationId,
  });
  record({
    phase: 'destroy',
    runtime,
    label: 'no port reserved in the database',
    ok: (allocated ?? null) === null,
    detail: allocated === null || allocated === undefined ? 'released' : `port ${allocated} left`,
  });

  // A test script is allowed to know both runtimes; the pipeline, for its part,
  // never must. It is the only asymmetric check of the file.
  const residue =
    runtime === 'k3s'
      ? {
          label: 'K3s namespace gone',
          command:
            'if [ -z "${KUBECONFIG:-}" ] && [ -r /etc/rancher/k3s/k3s.yaml ]; ' +
            'then KUBECONFIG=/etc/rancher/k3s/k3s.yaml; export KUBECONFIG; fi\n' +
            `kubectl get namespace app-${ctx.appSlug} --no-headers 2>/dev/null`,
        }
      : {
          label: 'no Docker container left',
          command: `docker ps -a --filter 'label=pupitre.app=${ctx.appSlug}' --format '{{.Names}}'`,
        };

  const check = await exec(side.session, residue.command, { timeout: 30_000 });
  record({
    phase: 'destroy',
    runtime,
    label: residue.label,
    ok: check.stdout.trim().length === 0,
    detail: check.stdout.trim() || 'nothing remains',
  });
}

// ─── known limits ─────────────────────────────────────────────────────────────

/**
 * What this test **does not exercise**.
 *
 * This section long carried an exclusion: building from a Dockerfile,
 * impossible on a K3s node for lack of `docker`. It is gone — the K3s driver
 * now sets a builder in the cluster and imports the image into the node's
 * containerd. The fixture proves it rather than working around it.
 *
 * What remains here no longer duplicates the drivers' knowledge: it is each
 * one's preflight, shown at step 4, that says whether it can build — and a
 * failing preflight makes the deployment fail, it is not hidden. `exclude()`
 * stays in place for the next capability a runtime will not have: a limit is
 * named, it is not deleted.
 */
async function reportLimitations(sides: Side[], spec: AppSpec): Promise<void> {
  const buildable = spec.services.filter((service) => service.source.type === 'dockerfile');

  if (buildable.length === 0) {
    exclude({
      runtime: 'k3s',
      label: 'building an image from a Dockerfile (`source.type: "dockerfile"`)',
      reason:
        'The spec provided builds nothing: all its services reference published images. ' +
        "So the two drivers' build path is not exercised by this run.",
      reference: `Default fixture: ${path.relative(ROOT, DEFAULT_SPEC)}, which does build.`,
    });
    return;
  }

  const names = buildable.map((service) => `"${service.name}"`).join(', ');
  for (const side of sides) {
    write(
      `  ${green('OK')} [${side.runtime}] ${side.targetName} will build ${names} ` +
        `${dim("— the capability is checked by the driver's preflight, step 4")}\n`,
    );
  }
}

// ─── summary ──────────────────────────────────────────────────────────────────

function summary(): boolean {
  const phases = ['deploy', 'rollback', 'destroy'];
  const labels = [...new Set(checks.map((check) => `${check.phase} ${check.label}`))];

  const width = Math.max(...labels.map((key) => (key.split(' ')[1] ?? '').length), 'Check'.length);

  write(`\n${bold('Summary — one AppSpec, two runtimes')}\n\n`);
  write(`  ${'Phase'.padEnd(9)}${'Check'.padEnd(width + 2)}${'docker'.padEnd(9)}k3s\n`);
  write(`  ${'─'.repeat(9 + width + 2 + 9 + 3)}\n`);

  for (const phase of phases) {
    for (const key of labels) {
      const [checkPhase, label] = key.split(' ');
      if (checkPhase !== phase || !label) continue;

      const cell = (runtime: RuntimeKind) => {
        const found = checks.find(
          (check) =>
            check.phase === phase && check.label === label && check.runtime === runtime,
        );
        if (!found) return yellow('—');
        return found.ok ? green('✓') : red('✗');
      };

      write(
        `  ${phase.padEnd(9)}${label.padEnd(width + 2)}${cell('docker').padEnd(17)}${cell('k3s')}\n`,
      );
    }
  }

  const failed = checks.filter((check) => !check.ok);
  write(`\n  ${checks.length - failed.length}/${checks.length} check(s) green`);
  write(
    limitations.length > 0
      ? `, ${limitations.length} known limit(s) excluded from the count\n`
      : '\n',
  );

  if (failed.length > 0) {
    write(`\n${red(bold('Failures:'))}\n`);
    for (const check of failed) {
      write(`  ${red('✗')} [${check.runtime}] ${check.phase} — ${check.label}\n`);
      if (check.detail) write(`      ${dim(check.detail)}\n`);
    }
  }

  // Named, justified, outside the count. A box that disappears says nothing; a
  // "not applicable, and here is why" line reads again.
  if (limitations.length > 0) {
    write(`\n${yellow(bold('Known limits — explicitly out of scope:'))}\n`);
    for (const limitation of limitations) {
      write(`  ${yellow('N/A')} [${limitation.runtime}] ${limitation.label}\n`);
      write(`      ${dim(limitation.reason)}\n`);
      write(`      ${dim(limitation.reference)}\n`);
    }
  }

  return failed.length === 0;
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  step('1. A single AppSpec');
  const spec = parseAppSpec(JSON.parse(readFileSync(options.specPath, 'utf8')));
  write(
    `  ${green('OK')} ${spec.name} v${spec.version} — ${spec.services.length} service(s)\n`,
  );
  info(path.relative(ROOT, options.specPath));
  info('This spec will not be changed between the two runtimes. That is the whole test.');

  const contexts = buildContexts(spec);
  if (contexts.length > 0) {
    info(`build contexts provided: ${contexts.map((file) => file.path).join(', ')}`);
  }

  const applicationId = await ensureApplication(spec);
  const sides: Side[] = [];

  try {
    step('2. Opening both targets');
    for (const [runtime, ref] of [
      ['docker', options.dockerTarget],
      ['k3s', options.k3sTarget],
    ] as Array<[RuntimeKind, string]>) {
      const side = await openSide(runtime, ref, spec, applicationId, contexts);
      sides.push(side);
      write(`  ${green('OK')} ${runtime} → ${side.targetName} (${side.targetHost})\n`);
    }

    step('3. What this test does not exercise');
    await reportLimitations(sides, spec);

    const probePath = spec.ingress
      ? (spec.services.find((service) => service.name === spec.ingress?.targetService)
          ?.healthcheck.path ?? '/')
      : (spec.services.find((service) => service.exposed)?.healthcheck.path ?? '/');

    for (const side of sides) {
      step(`4. Deployment on ${side.targetName} — runtime ${side.runtime}`);
      await deploySide(side, probePath);
    }

    for (const side of sides) {
      step(`5. Rollback on ${side.targetName} — runtime ${side.runtime}`);
      await rollbackSide(side, probePath);
    }

    if (options.keep) {
      step('6. Destroy — skipped (--keep)');
      info(
        `Cleanup: pnpm test:parity ${options.dockerTarget} ${options.k3sTarget}` +
          ' (without --keep) will rerun a complete cycle.',
      );
    } else {
      for (const side of sides) {
        step(`6. Destroy on ${side.targetName} — runtime ${side.runtime}`);
        await destroySide(side);
      }
    }

    const allGreen = summary();
    if (allGreen) {
      write(`\n${green(bold('Parity verified: the same AppSpec runs on both runtimes.'))}\n\n`);
    } else {
      write(`\n${red(bold('Parity NOT verified.'))}\n\n`);
      process.exitCode = 1;
    }
  } finally {
    for (const side of sides) {
      await disconnect(side.session);
    }
    await closeDb();
  }
}

main().catch((error: unknown) => {
  write(`\n${red(error instanceof Error ? (error.stack ?? error.message) : String(error))}\n`);
  process.exitCode = 1;
  void closeDb();
});
