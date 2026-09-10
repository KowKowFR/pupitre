/**
 * Déploie une AppSpec de bout en bout sur une cible Docker réelle.
 *
 * C'est le critère de sortie de la première moitié du jalon 4 : pas de
 * pipeline, pas d'UI, juste le driver appelé directement.
 *
 *   pnpm test:driver <cible> [--spec chemin.json] [--keep]
 *   pnpm test:driver <cible> --rollback <version>
 *   pnpm test:driver <cible> --destroy
 *
 * `<cible>` est le nom ou l'UUID d'une cible enregistrée au jalon 3.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decrypt, parseAppSpec, type AppSpec } from '@tp/core';
import { getDriver, type DriverContext, type DriverDeployment } from '@tp/core/drivers';
import { connect, disconnect, type SshTarget } from '@tp/core/ssh';
import {
  applications,
  closeDb,
  createPortAllocator,
  eq,
  getDb,
  getTargetSecret,
  listTargets,
} from '@tp/db';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SPEC = path.join(ROOT, 'packages/core/src/spec/__fixtures__/simple.json');

const ESC = String.fromCharCode(27);
const paint = (code: string) => (text: string) => `${ESC}[${code}m${text}${ESC}[0m`;
const bold = paint('1');
const green = paint('32');
const red = paint('31');
const dim = paint('2');

function step(title: string): void {
  process.stdout.write(`\n${bold(title)}\n`);
}
function ok(message: string): void {
  process.stdout.write(`  ${green('OK')} ${message}\n`);
}
function info(message: string): void {
  process.stdout.write(`    ${dim(message)}\n`);
}
function fail(message: string): never {
  process.stdout.write(`  ${red('KO')} ${message}\n`);
  throw new Error(message);
}

type Options = {
  target: string;
  specPath: string;
  destroy: boolean;
  keep: boolean;
  /** Version vers laquelle revenir, si `--rollback` est passé. */
  rollbackTo: string | null;
};

function parseArgs(argv: string[]): Options {
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  const target = positional[0];

  if (!target) {
    process.stdout.write(
      'Usage : pnpm test:driver <nom-ou-id-de-cible> [--spec fichier.json] [--destroy] [--keep]\n',
    );
    process.exit(1);
  }

  const specIndex = argv.indexOf('--spec');
  const rollbackIndex = argv.indexOf('--rollback');
  return {
    target,
    specPath: specIndex === -1 ? DEFAULT_SPEC : (argv[specIndex + 1] ?? DEFAULT_SPEC),
    destroy: argv.includes('--destroy'),
    keep: argv.includes('--keep'),
    rollbackTo: rollbackIndex === -1 ? null : (argv[rollbackIndex + 1] ?? null),
  };
}

/** Une ligne `applications` est nécessaire : `port_allocations` la référence. */
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

  if (!created) throw new Error("l'insertion de l'application n'a rien retourné");
  return created.id;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  step('0. AppSpec');
  const spec = parseAppSpec(JSON.parse(readFileSync(options.specPath, 'utf8')));
  ok(`${spec.name} v${spec.version} — ${spec.services.length} service(s)`);
  info(path.relative(ROOT, options.specPath));

  step('1. Cible');
  const all = await listTargets();
  const found = all.find(
    (candidate) => candidate.id === options.target || candidate.name === options.target,
  );
  if (!found) {
    fail(
      `Cible « ${options.target} » introuvable. Cibles connues : ` +
        (all.map((t) => t.name).join(', ') || 'aucune'),
    );
  }

  const record = await getTargetSecret(found.id);
  if (!record) fail(`Impossible de relire la cible ${found.id}`);

  ok(`${found.name} — ${found.sshUser}@${found.host}:${found.port}`);
  // Le dernier preflight enregistré vient du worker, qui voit le réseau
  // autrement que ce script. C'est `driver.preflight()`, ouvert sur notre
  // propre session, qui fait autorité — voir l'étape 3.
  info(
    record.target.runtimesAvailable.docker.available
      ? `dernier preflight : Docker ${record.target.runtimesAvailable.docker.version}`
      : `dernier preflight : ${record.target.status} — vérifié à l'étape 3`,
  );

  step('2. Session SSH');
  const secret = decrypt(record.encryptedCredential);
  const sshTarget: SshTarget = {
    host: record.target.host,
    port: record.target.port,
    username: record.target.sshUser,
    sudoMethod: record.target.sudoMethod,
    credentials:
      record.target.authMethod === 'key'
        ? { authMethod: 'key', privateKey: secret }
        : { authMethod: 'password', password: secret },
  };

  const session = await connect(sshTarget);
  ok(`connectée en ${session.latencyMs} ms`);

  const applicationId = await ensureApplication(spec);
  const driver = getDriver('docker');

  const deployment: DriverDeployment = {
    id: `test-driver-${Date.now()}`,
    version: spec.version,
    sequence: 1,
  };

  const previousDeployment: DriverDeployment | undefined = options.rollbackTo
    ? { id: 'previous', version: options.rollbackTo, sequence: 0 }
    : undefined;

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
    appSlug: spec.name,
    applicationId,
    ...(previousDeployment ? { previousDeployment } : {}),
    portAllocator: createPortAllocator(),
    // Plage restreinte quand la cible n'ouvre qu'une partie des ports.
    ...(process.env.DRIVER_PORT_RANGE
      ? {
          portRange: (() => {
            const [min, max] = process.env.DRIVER_PORT_RANGE.split('-').map(Number);
            return { min: min ?? 30_000, max: max ?? 32_767 };
          })(),
        }
      : {}),
  };

  const emit = (line: string) => process.stdout.write(`  ${dim(line)}\n`);

  try {
    step('3. preflight()');
    const preflight = await driver.preflight(ctx);
    for (const check of preflight.checks) {
      process.stdout.write(
        `  ${check.ok ? green('OK') : red('KO')} ${check.label} ${dim(check.detail ?? '')}\n`,
      );
    }
    if (!preflight.ok) fail("la cible ne peut pas accueillir ce déploiement");

    step('4. allocatePort()');
    const port = await driver.allocatePort(ctx);
    ok(`port ${port} réservé dans port_allocations (contrainte unique target_id/port)`);

    step('5. render()');
    const artifacts = await driver.render(ctx);
    ok(`projet ${artifacts.projectName}, ${artifacts.files.length} fichier(s)`);
    for (const file of artifacts.files) {
      info(`${file.path} — ${file.content.length} octets, mode ${(file.mode ?? 0o644).toString(8)}`);
    }

    if (options.destroy) {
      step('6. destroy()');
      await driver.destroy(ctx, emit);
      ok('déploiement détruit');
      return;
    }

    if (options.rollbackTo) {
      step(`6. rollback() vers ${options.rollbackTo}`);
      await driver.rollback(ctx, emit);

      const health = await driver.healthcheck(ctx);
      if (!health.healthy) {
        fail(`après rollback, sonde en échec : ${health.detail ?? 'sans détail'}`);
      }
      ok(`revenu à ${options.rollbackTo} — HTTP ${health.statusCode}`);
      return;
    }

    step('6. upload() → build() → deploy()');
    const started = Date.now();
    await driver.upload(ctx, artifacts, emit);
    const built = await driver.build(ctx, emit);
    info(built === null ? 'build : rien à construire (skipped)' : `build : ${built.join(', ')}`);
    const result = await driver.deploy(ctx, emit);
    ok(`déployé en ${Math.round((Date.now() - started) / 1000)} s`);
    info(`release : ${result.releasePath}`);
    info(`images  : ${result.images.join(', ') || '—'}`);

    step('7. healthcheck()');
    const health = await driver.healthcheck(ctx);
    if (!health.healthy) {
      fail(
        `sonde en échec après ${health.attempts} tentative(s) : ${health.detail ?? 'sans détail'}`,
      );
    }
    ok(`sain après ${health.attempts} tentative(s) — HTTP ${health.statusCode}`);

    step("8. L'URL répond");
    if (!result.url) fail("le driver n'a pas produit d'URL");

    const response = await fetch(result.url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) fail(`${result.url} → HTTP ${response.status}`);
    const body = await response.text();
    ok(`${result.url} → HTTP ${response.status}`);
    info(body.trim().split('\n')[0]?.slice(0, 80) ?? '');

    process.stdout.write(`\n${green(bold('Driver Docker vérifié de bout en bout.'))}\n`);
    process.stdout.write(`${bold(`  URL : ${result.url}`)}\n`);

    if (options.keep) {
      process.stdout.write(
        `${dim(`  Déploiement conservé. Nettoyage : pnpm test:driver ${options.target} --destroy`)}\n`,
      );
    } else {
      step('9. Nettoyage');
      await driver.destroy(ctx, emit);
      ok('cible remise dans son état initial');
    }
    process.stdout.write('\n');
  } finally {
    await disconnect(session);
    await closeDb();
  }
}

main().catch((error: unknown) => {
  process.stdout.write(`\n${red(error instanceof Error ? error.message : String(error))}\n`);
  process.exitCode = 1;
  void closeDb();
});
