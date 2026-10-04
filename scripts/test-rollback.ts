/**
 * Going back finds the right code — even when the version does not change.
 *
 *   pnpm test:rollback <docker-target> <k3s-target>
 *
 * A code commit does not change the AppSpec's version. On each runtime, an
 * application built from its code:
 *   1. release A, then release B **of the same version** — B is served;
 *   2. back to the previous release — A is served again;
 *   3. (Docker) a release from before the `-r{number}` naming is still found;
 *   4. the cleanup: beyond five releases, the oldest ones go, and their built
 *      images with them; the recent ones stay;
 *   5. the destruction leaves no built image behind it.
 * Then everything is destroyed. Exit code 1 at the first failure.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseAppSpec } from '@pupitre/core';
import {
  getDriver,
  type DriverContext,
  type DriverDeployment,
  type RuntimeKind,
} from '@pupitre/core/drivers';
import { disconnect, exec } from '@pupitre/core/ssh';
import { applications, closeDb, createPortAllocator, eq, getDb } from '@pupitre/db';
import { bold, createReport, dim, red, write } from './lib/report.js';
import { ensureApplication, openTarget, portRangeFromEnv } from './lib/targets.js';

const report = createReport();
const { record } = report;

const SPEC = parseAppSpec({
  name: 'retour-arriere',
  version: '1.0.0',
  services: [
    {
      name: 'web',
      source: { type: 'dockerfile', context: 'app', dockerfile: 'Dockerfile' },
      port: 8080,
      exposed: true,
      healthcheck: { path: '/', intervalSec: 3, timeoutSec: 3, retries: 20 },
    },
  ],
});

/** A "repository" archive whose page says `label`. */
function archive(label: string): { localPath: string; cleanup: () => void } {
  const work = mkdtempSync(path.join(tmpdir(), 'pupitre-retour-'));
  const repo = path.join(work, 'repo-abc1234');
  mkdirSync(path.join(repo, 'app'), { recursive: true });
  writeFileSync(
    path.join(repo, 'app', 'Dockerfile'),
    'FROM busybox:1.37\nCOPY index.html /www/index.html\nEXPOSE 8080\nCMD ["httpd", "-f", "-p", "8080", "-h", "/www"]\n',
  );
  writeFileSync(path.join(repo, 'app', 'index.html'), `version ${label}\n`);
  const localPath = path.join(work, 'source.tar.gz');
  execFileSync('tar', ['-czf', localPath, '-C', work, path.basename(repo)]);
  return { localPath, cleanup: () => rmSync(work, { recursive: true, force: true }) };
}

async function exercise(runtime: RuntimeKind, ref: string, applicationId: string): Promise<void> {
  write(`\n${bold(`── ${runtime} — ${ref}`)}\n`);
  const { session, target } = await openTarget(ref);
  const driver = getDriver(runtime);
  const log = (line: string) => write(`    ${dim(line)}\n`);
  const root = process.env.DRIVER_ROOT_PATH ?? '/opt/bootstrap';
  const appPath = `${root}/apps/${SPEC.name}`;
  const base: Omit<DriverContext, 'deployment'> = {
    spec: SPEC,
    target: { id: target.id, name: target.name, host: target.host, rootPath: root },
    sshSession: session,
    language: 'fr',
    appSlug: SPEC.name,
    applicationId,
    portAllocator: createPortAllocator(),
    ...portRangeFromEnv(),
    resolveSecrets: async () => ({}),
    sourceInRelease: true,
  };
  const release = (sequence: number): DriverDeployment => ({
    id: `retour-${runtime}-${sequence}`,
    version: SPEC.version,
    sequence,
  });
  let port: number | null = null;

  async function deploy(sequence: number, label: string, previous: number | null): Promise<void> {
    const ctx: DriverContext = {
      ...base,
      deployment: release(sequence),
      ...(previous !== null ? { previousDeployment: release(previous) } : {}),
    };
    const source = archive(label);
    try {
      port = (await driver.allocatePort(ctx, () => {})) ?? port;
      const artifacts = await driver.render(ctx);
      port = artifacts.publishedPort ?? port;
      await driver.upload(
        { ...ctx, sourceArchive: { localPath: source.localPath, stripComponents: 1 } },
        artifacts,
        () => {},
      );
      await driver.build(ctx, () => {});
      await driver.deploy(ctx, log);
      const health = await driver.healthcheck(ctx);
      if (!health.healthy)
        throw new Error(`release r${sequence} unhealthy: ${health.detail ?? ''}`);
    } finally {
      source.cleanup();
    }
  }

  async function served(): Promise<string> {
    if (runtime === 'docker') {
      const result = await exec(session, `curl -s -m 5 http://127.0.0.1:${port}/ || true`);
      return result.stdout.trim();
    }
    const kube = 'export KUBECONFIG=${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}; ';
    const result = await exec(
      session,
      `${kube}kubectl -n app-${SPEC.name} port-forward svc/web 39190:8080 >/dev/null 2>&1 & ` +
        'PF=$!; sleep 3; curl -s -m 5 http://127.0.0.1:39190/ || true; kill $PF 2>/dev/null; true',
    );
    return result.stdout.trim();
  }

  async function images(): Promise<string> {
    const list =
      runtime === 'docker'
        ? `docker image ls --format '{{.Repository}}:{{.Tag}}' | grep '^app-${SPEC.name}/' || true`
        : `k3s crictl images 2>/dev/null | awk '/app-${SPEC.name}\\/web/ {print $1":"$2}' || true`;
    return (await exec(session, list, runtime === 'k3s' ? { sudo: true } : {})).stdout.trim();
  }

  const first = 7001;
  try {
    await deploy(first, 'A', null);
    record(runtime, 'release A served', (await served()) === 'version A');

    await deploy(first + 1, 'B', first);
    const both = (await exec(session, `ls -1 ${appPath} | grep -v current | tr '\\n' ' '`)).stdout;
    record(
      runtime,
      'release B of the same version, apart: its directory and its image',
      (await served()) === 'version B' &&
        both.includes(`1.0.0-r${first}`) &&
        both.includes(`1.0.0-r${first + 1}`) &&
        (await images()).includes(`1.0.0-r${first + 1}`),
      both.trim(),
    );

    await driver.rollback(
      { ...base, deployment: release(first + 1), previousDeployment: release(first) },
      log,
    );
    record(runtime, 'going back: A served again', (await served()) === 'version A');

    let next = first + 2;
    if (runtime === 'docker') {
      // A release from before the `-r{number}` naming: the same, under the version alone.
      await exec(session, `mv ${appPath}/1.0.0-r${first} ${appPath}/1.0.0`);
      await deploy(next, 'C', first + 1);
      await driver.rollback(
        { ...base, deployment: release(next), previousDeployment: release(first) },
        log,
      );
      record(
        runtime,
        'a release from before the naming is still found',
        (await served()) === 'version A',
      );
      // And the usual operations on it — its health — still go through.
      const legacy = await driver.healthcheck({ ...base, deployment: release(first) });
      record(
        runtime,
        'an application from before the update stays operable (health)',
        legacy.healthy,
        legacy.detail ?? '',
      );
      next += 1;
    }

    // The cleanup: five releases kept, the others go with their images.
    for (let index = 0; index < 5; index += 1) {
      await deploy(next, `D${index}`, next - 1);
      next += 1;
    }
    const kept = (await exec(session, `ls -1 ${appPath} | grep -v current | tr '\\n' ' '`)).stdout;
    const tags = await images();
    record(
      runtime,
      'five releases kept, the old ones gone with their images',
      !kept.includes(`1.0.0-r${first + 1} `) &&
        !tags.includes(`1.0.0-r${first + 1}`) &&
        tags.includes(`1.0.0-r${next - 1}`) &&
        kept.trim().split(/\s+/).length === 5,
      `${kept.trim()} · images: ${tags.split('\n').length}`,
    );
  } catch (error) {
    record(runtime, 'run', false, error instanceof Error ? error.message : String(error));
  } finally {
    await driver.destroy({ ...base, deployment: release(first) }, () => {}).catch(() => undefined);
    // The destruction also removes the built images, all releases together.
    const left = await images().catch(() => '?');
    record(runtime, 'the destruction removes the built images', left === '', left || 'none');
    await disconnect(session);
  }
}

async function main(): Promise<void> {
  const [dockerRef, k3sRef] = process.argv.slice(2);
  if (!dockerRef || !k3sRef) {
    write('Usage: pnpm test:rollback <docker-target> <k3s-target>\n');
    process.exit(1);
  }
  write(bold('Going back finds the right code, even without changing the version\n'));
  const applicationId = await ensureApplication(SPEC);
  await exercise('docker', dockerRef, applicationId);
  await exercise('k3s', k3sRef, applicationId);
  await getDb().delete(applications).where(eq(applications.id, applicationId));
  await closeDb();
  report.summary('Going back holds.');
  process.exit(report.failures === 0 ? 0 : 1);
}

main().catch(async (error: unknown) => {
  write(red(`\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`));
  await closeDb().catch(() => undefined);
  process.exit(1);
});
