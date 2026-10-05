/**
 * Deploys an AppSpec end to end on a real Docker target.
 *
 * It is the shortest path between an AppSpec and a URL that answers: no
 * pipeline, no UI, just the driver called directly.
 *
 *   pnpm test:driver <target> [--spec path.json] [--keep]
 *   pnpm test:driver <target> --rollback <version>
 *   pnpm test:driver <target> --destroy
 *
 * `<target>` is the name or the UUID of a target registered in the panel.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decrypt, parseAppSpec, type AppSpec } from '@pupitre/core';
import { getDriver, type DriverContext, type DriverDeployment } from '@pupitre/core/drivers';
import { connect, disconnect, type SshTarget } from '@pupitre/core/ssh';
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
  /** Version to go back to, if `--rollback` is passed. */
  rollbackTo: string | null;
};

function parseArgs(argv: string[]): Options {
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  const target = positional[0];

  if (!target) {
    process.stdout.write(
      'Usage: pnpm test:driver <target-name-or-id> [--spec file.json] [--destroy] [--keep]\n',
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
      `Target "${options.target}" not found. Known targets: ` +
        (all.map((t) => t.name).join(', ') || 'none'),
    );
  }

  const record = await getTargetSecret(found.id);
  if (!record) fail(`Could not read target ${found.id} again`);

  ok(`${found.name} — ${found.sshUser}@${found.host}:${found.port}`);
  // The last recorded preflight comes from the worker, which sees the network
  // differently from this script. It is `driver.preflight()`, opened on our own
  // session, that is authoritative — see step 3.
  info(
    record.target.runtimesAvailable.docker.available
      ? `last preflight: Docker ${record.target.runtimesAvailable.docker.version}`
      : `last preflight: ${record.target.status} — checked at step 3`,
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
  ok(`connected in ${session.latencyMs} ms`);

  const applicationId = await ensureApplication(spec);
  const driver = getDriver('docker');

  const deployment: DriverDeployment = {
    id: `test-driver-${Date.now()}`,
    version: spec.version,
    sequence: 1,
  };

  const previousDeployment: DriverDeployment | undefined = options.rollbackTo
    ? // This script always deploys under number 1: the targeted release is
      // `{version}-r1`, or `{version}` if it dates from before this naming.
      { id: 'previous', version: options.rollbackTo, sequence: 1 }
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
    language: 'en',
    appSlug: spec.name,
    applicationId,
    ...(previousDeployment ? { previousDeployment } : {}),
    portAllocator: createPortAllocator(),
    // Restricted range when the target only opens part of the ports.
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
    if (!preflight.ok) fail('the target cannot host this deployment');

    step('4. allocatePort()');
    const port = await driver.allocatePort(ctx);
    ok(`port ${port} reserved in port_allocations (unique target_id/port constraint)`);

    step('5. render()');
    const artifacts = await driver.render(ctx);
    ok(`project ${artifacts.projectName}, ${artifacts.files.length} file(s)`);
    for (const file of artifacts.files) {
      info(`${file.path} — ${file.content.length} octets, mode ${(file.mode ?? 0o644).toString(8)}`);
    }

    if (options.destroy) {
      step('6. destroy()');
      await driver.destroy(ctx, emit);
      ok('deployment destroyed');
      return;
    }

    if (options.rollbackTo) {
      step(`6. rollback() to ${options.rollbackTo}`);
      await driver.rollback(ctx, emit);

      const health = await driver.healthcheck(ctx);
      if (!health.healthy) {
        fail(`after rollback, probe failing: ${health.detail ?? 'no detail'}`);
      }
      ok(`back to ${options.rollbackTo} — HTTP ${health.statusCode}`);
      return;
    }

    step('6. upload() → build() → deploy()');
    const started = Date.now();
    await driver.upload(ctx, artifacts, emit);
    const built = await driver.build(ctx, emit);
    info(built === null ? 'build: nothing to build (skipped)' : `build: ${built.join(', ')}`);
    const result = await driver.deploy(ctx, emit);
    ok(`deployed in ${Math.round((Date.now() - started) / 1000)} s`);
    info(`release: ${result.releasePath}`);
    info(`images  : ${result.images.join(', ') || '—'}`);

    step('7. healthcheck()');
    const health = await driver.healthcheck(ctx);
    if (!health.healthy) {
      fail(
        `probe failing after ${health.attempts} attempt(s): ${health.detail ?? 'no detail'}`,
      );
    }
    ok(`healthy after ${health.attempts} attempt(s) — HTTP ${health.statusCode}`);

    step('8. The URL answers');
    if (!result.url) fail('the driver produced no URL');

    const response = await fetch(result.url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) fail(`${result.url} → HTTP ${response.status}`);
    const body = await response.text();
    ok(`${result.url} → HTTP ${response.status}`);
    info(body.trim().split('\n')[0]?.slice(0, 80) ?? '');

    process.stdout.write(`\n${green(bold('Docker driver verified end to end.'))}\n`);
    process.stdout.write(`${bold(`  URL: ${result.url}`)}\n`);

    if (options.keep) {
      process.stdout.write(
        `${dim(`  Deployment kept. Cleanup: pnpm test:driver ${options.target} --destroy`)}\n`,
      );
    } else {
      step('9. Cleanup');
      await driver.destroy(ctx, emit);
      ok('target given back its initial state');
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
