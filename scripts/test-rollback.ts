/**
 * Revenir en arrière retrouve le bon code — même quand la version ne change pas.
 *
 *   pnpm test:rollback <cible-docker> <cible-k3s>
 *
 * Un commit de code ne change pas la version de l'AppSpec. Sur chaque runtime,
 * une application construite depuis son code :
 *   1. la release A, puis la release B **de la même version** — B est servie ;
 *   2. retour à la release précédente — A est servie de nouveau ;
 *   3. (Docker) une release d'avant le nommage `-r{numéro}` se retrouve encore ;
 *   4. le ménage : au-delà de cinq releases, les plus anciennes partent, et
 *      leurs images construites avec elles ; les récentes restent ;
 *   5. la destruction ne laisse aucune image construite derrière elle.
 * Puis tout est détruit. Sortie en code 1 au premier échec.
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

/** Une archive de « dépôt » dont la page dit `label`. */
function archive(label: string): { localPath: string; cleanup: () => void } {
  const work = mkdtempSync(path.join(tmpdir(), 'pupitre-retour-'));
  const repo = path.join(work, 'depot-abc1234');
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
        throw new Error(`release r${sequence} en mauvaise santé : ${health.detail ?? ''}`);
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
    record(runtime, 'release A servie', (await served()) === 'version A');

    await deploy(first + 1, 'B', first);
    const both = (await exec(session, `ls -1 ${appPath} | grep -v current | tr '\\n' ' '`)).stdout;
    record(
      runtime,
      'release B de la même version, à part : son répertoire et son image',
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
    record(runtime, 'retour en arrière : A servie de nouveau', (await served()) === 'version A');

    let next = first + 2;
    if (runtime === 'docker') {
      // Une release d'avant le nommage `-r{numéro}` : la même, sous la seule version.
      await exec(session, `mv ${appPath}/1.0.0-r${first} ${appPath}/1.0.0`);
      await deploy(next, 'C', first + 1);
      await driver.rollback(
        { ...base, deployment: release(next), previousDeployment: release(first) },
        log,
      );
      record(
        runtime,
        'une release d’avant le nommage se retrouve encore',
        (await served()) === 'version A',
      );
      // Et les opérations courantes sur elle — sa santé — passent toujours.
      const legacy = await driver.healthcheck({ ...base, deployment: release(first) });
      record(
        runtime,
        'une application d’avant la mise à jour reste pilotable (santé)',
        legacy.healthy,
        legacy.detail ?? '',
      );
      next += 1;
    }

    // Le ménage : cinq releases gardées, les autres partent avec leurs images.
    for (let index = 0; index < 5; index += 1) {
      await deploy(next, `D${index}`, next - 1);
      next += 1;
    }
    const kept = (await exec(session, `ls -1 ${appPath} | grep -v current | tr '\\n' ' '`)).stdout;
    const tags = await images();
    record(
      runtime,
      'cinq releases gardées, les anciennes parties avec leurs images',
      !kept.includes(`1.0.0-r${first + 1} `) &&
        !tags.includes(`1.0.0-r${first + 1}`) &&
        tags.includes(`1.0.0-r${next - 1}`) &&
        kept.trim().split(/\s+/).length === 5,
      `${kept.trim()} · images : ${tags.split('\n').length}`,
    );
  } catch (error) {
    record(runtime, 'déroulé', false, error instanceof Error ? error.message : String(error));
  } finally {
    await driver.destroy({ ...base, deployment: release(first) }, () => {}).catch(() => undefined);
    // La destruction retire aussi les images construites, toutes releases confondues.
    const left = await images().catch(() => '?');
    record(runtime, 'la destruction retire les images construites', left === '', left || 'aucune');
    await disconnect(session);
  }
}

async function main(): Promise<void> {
  const [dockerRef, k3sRef] = process.argv.slice(2);
  if (!dockerRef || !k3sRef) {
    write('Usage : pnpm test:rollback <cible-docker> <cible-k3s>\n');
    process.exit(1);
  }
  write(bold('Revenir en arrière retrouve le bon code, même sans changer de version\n'));
  const applicationId = await ensureApplication(SPEC);
  await exercise('docker', dockerRef, applicationId);
  await exercise('k3s', k3sRef, applicationId);
  await getDb().delete(applications).where(eq(applications.id, applicationId));
  await closeDb();
  report.summary('Le retour en arrière tient.');
  process.exit(report.failures === 0 ? 0 : 1);
}

main().catch(async (error: unknown) => {
  write(red(`\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`));
  await closeDb().catch(() => undefined);
  process.exit(1);
});
