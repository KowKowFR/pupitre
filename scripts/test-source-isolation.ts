/**
 * A booby-trapped repository does not get through: its code stays apart from
 * the release.
 *
 *   pnpm test:source-isolation <docker-target> <k3s-target>
 *
 * On each runtime, an application built from the archive of a "repository"
 * that carries, on top of its code:
 *   - a `compose.override.yml` that asks for a privileged container with the
 *     machine's disk mounted;
 *   - a `docker-compose.yml` and a `.env` that hijack the project's name;
 *   - a `k8s/` folder with a manifest to apply.
 * It must build from `source/`, start healthy, and no trap must have taken.
 * Then everything is destroyed. Exit code 1 at the first failure.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseAppSpec } from '@pupitre/core';
import {
  getDriver,
  releaseName,
  type DriverContext,
  type RuntimeKind,
} from '@pupitre/core/drivers';
import { disconnect, exec } from '@pupitre/core/ssh';
import { applications, closeDb, createPortAllocator, eq, getDb } from '@pupitre/db';
import { bold, createReport, dim, red, write } from './lib/report.js';
import { ensureApplication, openTarget, portRangeFromEnv } from './lib/targets.js';

const report = createReport();
const { record } = report;

const SPEC = parseAppSpec({
  name: 'source-trapped',
  version: '1.0.0',
  services: [
    {
      name: 'web',
      // Relative to the repository's root, as in a real pupitre.json.
      source: { type: 'dockerfile', context: 'app', dockerfile: 'Dockerfile' },
      port: 8080,
      exposed: true,
      healthcheck: { path: '/', intervalSec: 3, timeoutSec: 3, retries: 20 },
    },
  ],
});

/** An archive like GitHub's: everything under a leading folder. */
function hostileArchive(): { localPath: string; cleanup: () => void } {
  const work = mkdtempSync(path.join(tmpdir(), 'pupitre-trap-'));
  const repo = path.join(work, 'KowKowFR-trap-abc1234');
  mkdirSync(path.join(repo, 'app'), { recursive: true });
  mkdirSync(path.join(repo, 'k8s'), { recursive: true });
  writeFileSync(
    path.join(repo, 'app', 'Dockerfile'),
    'FROM busybox:1.37\nCOPY index.html /www/index.html\nEXPOSE 8080\nCMD ["httpd", "-f", "-p", "8080", "-h", "/www"]\n',
  );
  writeFileSync(path.join(repo, 'app', 'index.html'), '<h1>repository code</h1>\n');
  writeFileSync(
    path.join(repo, 'compose.override.yml'),
    'services:\n  web:\n    privileged: true\n    volumes: ["/:/host"]\n',
  );
  writeFileSync(
    path.join(repo, 'docker-compose.yml'),
    'services:\n  intruder:\n    image: busybox:1.37\n    command: ["sleep", "3600"]\n',
  );
  writeFileSync(
    path.join(repo, '.env'),
    'COMPOSE_PROJECT_NAME=app-victim\nCOMPOSE_FILE=docker-compose.yml\n',
  );
  writeFileSync(
    path.join(repo, 'k8s', 'trap.yaml'),
    'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: pupitre-trap\n  namespace: default\ndata:\n  taken: "yes"\n',
  );
  const localPath = path.join(work, 'source.tar.gz');
  execFileSync('tar', ['-czf', localPath, '-C', work, path.basename(repo)]);
  return { localPath, cleanup: () => rmSync(work, { recursive: true, force: true }) };
}

async function exercise(runtime: RuntimeKind, ref: string, applicationId: string): Promise<void> {
  write(`\n${bold(`── ${runtime} — ${ref}`)}\n`);
  const { session, target } = await openTarget(ref);
  const archive = hostileArchive();
  const driver = getDriver(runtime);
  const log = (line: string) => write(`    ${dim(line)}\n`);
  const ctx: DriverContext = {
    spec: SPEC,
    target: {
      id: target.id,
      name: target.name,
      host: target.host,
      rootPath: process.env.DRIVER_ROOT_PATH ?? '/opt/bootstrap',
    },
    deployment: { id: `trap-${runtime}-${Date.now()}`, version: SPEC.version, sequence: 1 },
    sshSession: session,
    language: 'en',
    appSlug: SPEC.name,
    applicationId,
    portAllocator: createPortAllocator(),
    ...portRangeFromEnv(),
    resolveSecrets: async () => ({}),
    sourceInRelease: true,
  };
  const release = `${ctx.target.rootPath}/apps/${SPEC.name}/${releaseName(ctx.deployment)}`;
  try {
    await driver.allocatePort(ctx, log);
    const artifacts = await driver.render(ctx);
    await driver.upload(
      { ...ctx, sourceArchive: { localPath: archive.localPath, stripComponents: 1 } },
      artifacts,
      log,
    );
    const layout = await exec(
      session,
      `ls -A ${release} | tr '\\n' ' '; echo; ls -A ${release}/source | tr '\\n' ' '`,
    );
    const [root = '', source = ''] = layout.stdout.split('\n');
    record(
      runtime,
      "the repository's code is in source/, not at the root of the release",
      source.includes('compose.override.yml') &&
        !root.includes('compose.override.yml') &&
        !root.includes('docker-compose.yml'),
      `root: ${root.trim()}`,
    );
    await driver.build(ctx, log);
    await driver.deploy(ctx, log);
    const health = await driver.healthcheck(ctx);
    record(runtime, 'built from source/app, started healthy', health.healthy, health.detail ?? '');

    if (runtime === 'docker') {
      const inspect = await exec(
        session,
        'docker ps -a --filter label=com.docker.compose.project --format \'{{.Names}} {{.Label "com.docker.compose.project"}}\'; ' +
          `docker inspect app-${SPEC.name}-web-1 --format '{{.HostConfig.Privileged}} {{range .Mounts}}{{.Destination}} {{end}}'`,
      );
      const lines = inspect.stdout.trim().split('\n');
      const containers = lines.slice(0, -1).join(' · ');
      const [privileged = '', ...mounts] = (lines.at(-1) ?? '').split(' ');
      record(
        runtime,
        "the repository's compose.override.yml is not merged",
        privileged === 'false' && !mounts.includes('/host'),
        `privileged=${privileged}, mounts: ${mounts.filter(Boolean).join(' ') || 'none'}`,
      );
      record(
        runtime,
        'neither a hijacked project, nor an intruding service',
        !containers.includes('app-victim') &&
          !containers.includes('intruder') &&
          containers.includes(`app-${SPEC.name}`),
        containers,
      );
    } else {
      const kube = 'export KUBECONFIG=${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}; ';
      const trap = await exec(
        session,
        `${kube}kubectl -n default get configmap pupitre-trap -o name 2>&1 || true`,
      );
      record(
        runtime,
        "the repository's k8s/ folder is not applied",
        /NotFound|not found/i.test(trap.stdout),
        trap.stdout.trim(),
      );
    }
  } catch (error) {
    record(runtime, 'run', false, error instanceof Error ? error.message : String(error));
  } finally {
    await driver.destroy(ctx, () => {}).catch(() => undefined);
    archive.cleanup();
    await disconnect(session);
  }
}

async function main(): Promise<void> {
  const [dockerRef, k3sRef] = process.argv.slice(2);
  if (!dockerRef || !k3sRef) {
    write('Usage: pnpm test:source-isolation <docker-target> <k3s-target>\n');
    process.exit(1);
  }
  write(bold('A booby-trapped repository does not get through — the code stays in source/\n'));
  const applicationId = await ensureApplication(SPEC);
  await exercise('docker', dockerRef, applicationId);
  await exercise('k3s', k3sRef, applicationId);
  await getDb().delete(applications).where(eq(applications.id, applicationId));
  await closeDb();
  report.summary('No trap took.');
  process.exit(report.failures === 0 ? 0 : 1);
}

main().catch(async (error: unknown) => {
  write(red(`\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`));
  await closeDb().catch(() => undefined);
  process.exit(1);
});
