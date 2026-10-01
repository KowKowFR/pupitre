/**
 * Un dépôt piégé ne passe pas : son code reste à part de la release.
 *
 *   pnpm test:source-isolation <cible-docker> <cible-k3s>
 *
 * Sur chaque runtime, une application construite depuis l'archive d'un
 * « dépôt » qui porte, en plus de son code :
 *   - un `compose.override.yml` qui demande un conteneur privilégié avec le
 *     disque de la machine monté ;
 *   - un `docker-compose.yml` et un `.env` qui détournent le nom du projet ;
 *   - un dossier `k8s/` avec un manifeste à appliquer.
 * Elle doit se construire depuis `source/`, démarrer saine, et aucun piège ne
 * doit avoir pris. Puis tout est détruit. Sortie en code 1 au premier échec.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decrypt, parseAppSpec } from '@pupitre/core';
import { getDriver, type DriverContext, type RuntimeKind } from '@pupitre/core/drivers';
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

const ESC = String.fromCharCode(27);
const paint = (code: string) => (text: string) => `${ESC}[${code}m${text}${ESC}[0m`;
const green = paint('32');
const red = paint('31');
const bold = paint('1');
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

const SPEC = parseAppSpec({
  name: 'source-piegee',
  version: '1.0.0',
  services: [
    {
      name: 'web',
      // Relatif à la racine du dépôt, comme dans un vrai pupitre.json.
      source: { type: 'dockerfile', context: 'app', dockerfile: 'Dockerfile' },
      port: 8080,
      exposed: true,
      healthcheck: { path: '/', intervalSec: 3, timeoutSec: 3, retries: 20 },
    },
  ],
});

/** Une archive comme celles de GitHub : tout sous un dossier de tête. */
function hostileArchive(): { localPath: string; cleanup: () => void } {
  const work = mkdtempSync(path.join(tmpdir(), 'pupitre-piege-'));
  const repo = path.join(work, 'KowKowFR-piege-abc1234');
  mkdirSync(path.join(repo, 'app'), { recursive: true });
  mkdirSync(path.join(repo, 'k8s'), { recursive: true });
  writeFileSync(
    path.join(repo, 'app', 'Dockerfile'),
    'FROM busybox:1.37\nCOPY index.html /www/index.html\nEXPOSE 8080\nCMD ["httpd", "-f", "-p", "8080", "-h", "/www"]\n',
  );
  writeFileSync(path.join(repo, 'app', 'index.html'), '<h1>code du depot</h1>\n');
  writeFileSync(
    path.join(repo, 'compose.override.yml'),
    'services:\n  web:\n    privileged: true\n    volumes: ["/:/hote"]\n',
  );
  writeFileSync(
    path.join(repo, 'docker-compose.yml'),
    'services:\n  intrus:\n    image: busybox:1.37\n    command: ["sleep", "3600"]\n',
  );
  writeFileSync(
    path.join(repo, '.env'),
    'COMPOSE_PROJECT_NAME=app-victime\nCOMPOSE_FILE=docker-compose.yml\n',
  );
  writeFileSync(
    path.join(repo, 'k8s', 'piege.yaml'),
    'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: pupitre-piege\n  namespace: default\ndata:\n  pris: "oui"\n',
  );
  const localPath = path.join(work, 'source.tar.gz');
  execFileSync('tar', ['-czf', localPath, '-C', work, path.basename(repo)]);
  return { localPath, cleanup: () => rmSync(work, { recursive: true, force: true }) };
}

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

async function open(
  ref: string,
): Promise<{ session: SshSession; target: { id: string; name: string; host: string } }> {
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
  return { session: await connect(ssh), target: found };
}

async function exercise(runtime: RuntimeKind, ref: string, applicationId: string): Promise<void> {
  write(`\n${bold(`── ${runtime} — ${ref}`)}\n`);
  const { session, target } = await open(ref);
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
    deployment: { id: `piege-${runtime}-${Date.now()}`, version: SPEC.version, sequence: 1 },
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
    sourceInRelease: true,
  };
  const release = `${ctx.target.rootPath}/apps/${SPEC.name}/${SPEC.version}`;
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
      'le code du dépôt est dans source/, pas à la racine de la release',
      source.includes('compose.override.yml') &&
        !root.includes('compose.override.yml') &&
        !root.includes('docker-compose.yml'),
      `racine : ${root.trim()}`,
    );
    await driver.build(ctx, log);
    await driver.deploy(ctx, log);
    const health = await driver.healthcheck(ctx);
    record(
      runtime,
      'construite depuis source/app, démarrée saine',
      health.healthy,
      health.detail ?? '',
    );

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
        'le compose.override.yml du dépôt n’est pas fusionné',
        privileged === 'false' && !mounts.includes('/hote'),
        `privileged=${privileged}, montages : ${mounts.filter(Boolean).join(' ') || 'aucun'}`,
      );
      record(
        runtime,
        'ni projet détourné, ni service intrus',
        !containers.includes('app-victime') &&
          !containers.includes('intrus') &&
          containers.includes(`app-${SPEC.name}`),
        containers,
      );
    } else {
      const kube = 'export KUBECONFIG=${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}; ';
      const trap = await exec(
        session,
        `${kube}kubectl -n default get configmap pupitre-piege -o name 2>&1 || true`,
      );
      record(
        runtime,
        'le dossier k8s/ du dépôt n’est pas appliqué',
        /NotFound|not found/i.test(trap.stdout),
        trap.stdout.trim(),
      );
    }
  } catch (error) {
    record(runtime, 'déroulé', false, error instanceof Error ? error.message : String(error));
  } finally {
    await driver.destroy(ctx, () => {}).catch(() => undefined);
    archive.cleanup();
    await disconnect(session);
  }
}

async function main(): Promise<void> {
  const [dockerRef, k3sRef] = process.argv.slice(2);
  if (!dockerRef || !k3sRef) {
    write('Usage : pnpm test:source-isolation <cible-docker> <cible-k3s>\n');
    process.exit(1);
  }
  write(bold('Un dépôt piégé ne passe pas — le code reste dans source/\n'));
  const applicationId = await ensureApplication();
  await exercise('docker', dockerRef, applicationId);
  await exercise('k3s', k3sRef, applicationId);
  await getDb().delete(applications).where(eq(applications.id, applicationId));
  await closeDb();
  write(`\n  ${passes} vérification(s) au vert, ${failures} en échec\n`);
  write(failures === 0 ? green(bold('\nAucun piège n’a pris.\n')) : red(bold('\nÉchec.\n')));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error: unknown) => {
  write(red(`\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`));
  await closeDb().catch(() => undefined);
  process.exit(1);
});
