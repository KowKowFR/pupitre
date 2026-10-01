/**
 * Le catalogue, pour de vrai.
 *
 * Chaque modèle du catalogue est déployé sur une cible, sondé, puis détruit —
 * par le même driver que le pipeline, avec les mêmes images, les mêmes sondes,
 * le même durcissement. Les tests unitaires prouvent qu'un modèle rend une
 * AppSpec valable ; ce script prouve qu'elle **démarre et répond**.
 *
 *   pnpm test:catalog <cible> [--only id,id] [--skip id,id] [--runtime docker|k3s]
 *                             [--prune-images] [--report fichier.md]
 *
 * Pour chaque modèle :
 *   1. l'AppSpec, rendue par le modèle comme à l'installation (sans domaine) ;
 *   2. port, rendu, dépôt sur la cible, déploiement — pull compris ;
 *   3. la sonde du driver, puis une requête HTTP depuis la cible sur le port
 *      publié et le chemin de santé du modèle : il faut un code 2xx ou 3xx ;
 *   4. destroy, et la vérification que rien ne reste (conteneurs, port).
 *
 * `--prune-images` supprime ensuite **toutes** les images inutilisées de la
 * cible, pour que vingt-huit modèles tiennent sur un disque de test. À ne
 * jamais passer sur une machine qui sert à autre chose.
 *
 * Une image publiée sans variante pour l'architecture de la cible (ARM, en
 * général) n'est pas un modèle cassé : elle est rapportée à part, hors du
 * décompte des échecs, avec l'architecture en cause.
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import {
  CATALOG_TEMPLATES,
  decrypt,
  instantiateCatalogTemplate,
  usableRuntimes,
  type AppSpec,
  type CatalogTemplate,
} from '@pupitre/core';
import {
  getDriver,
  type DeploymentDriver,
  type DriverContext,
  type RuntimeKind,
} from '@pupitre/core/drivers';
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
const bold = paint('1');
const green = paint('32');
const red = paint('31');
const yellow = paint('33');
const dim = paint('2');

function write(text: string): void {
  process.stdout.write(text);
}

// ─── arguments ────────────────────────────────────────────────────────────────

type Options = {
  target: string;
  only: string[] | null;
  skip: string[];
  runtime: RuntimeKind | null;
  pruneImages: boolean;
  report: string | null;
};

function listArg(argv: string[], flag: string): string[] | null {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  return (argv[index + 1] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseArgs(argv: string[]): Options {
  const valued = new Set(['--only', '--skip', '--runtime', '--report']);
  const positional = argv.filter(
    (arg, index) => !arg.startsWith('--') && !valued.has(argv[index - 1] ?? ''),
  );
  const target = positional[0];
  if (!target) {
    write(
      'Usage : pnpm test:catalog <cible> [--only id,id] [--skip id,id] [--runtime docker|k3s]\n' +
        '                          [--prune-images] [--report fichier.md]\n\n' +
        'La cible est un nom ou un UUID de cible enregistrée.\n' +
        `Modèles : ${CATALOG_TEMPLATES.map((template) => template.id).join(', ')}\n`,
    );
    process.exit(1);
  }
  const runtime = listArg(argv, '--runtime')?.[0] ?? null;
  if (runtime !== null && runtime !== 'docker' && runtime !== 'k3s') {
    write(`Runtime inconnu : ${runtime}\n`);
    process.exit(1);
  }
  return {
    target,
    only: listArg(argv, '--only'),
    skip: listArg(argv, '--skip') ?? [],
    runtime,
    pruneImages: argv.includes('--prune-images'),
    report: listArg(argv, '--report')?.[0] ?? null,
  };
}

// ─── cible ────────────────────────────────────────────────────────────────────

type Target = {
  id: string;
  name: string;
  host: string;
  runtime: RuntimeKind;
  session: SshSession;
  architecture: string;
};

async function openTarget(ref: string, wanted: RuntimeKind | null): Promise<Target> {
  const all = await listTargets();
  const found = all.find((candidate) => candidate.id === ref || candidate.name === ref);
  if (!found) {
    throw new Error(
      `Cible « ${ref} » introuvable. Cibles connues : ` +
        (all.map((target) => target.name).join(', ') || 'aucune'),
    );
  }
  const record = await getTargetSecret(found.id);
  if (!record) throw new Error(`Impossible de relire la cible ${found.id}`);

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
  const uname = await exec(session, 'uname -m', { timeout: 15_000 });
  // Le runtime : celui demandé, sinon le premier que le preflight a vu, sinon Docker.
  const runtime = wanted ?? usableRuntimes(found.runtimesAvailable)[0] ?? 'docker';
  return {
    id: found.id,
    name: found.name,
    host: found.host,
    runtime,
    session,
    architecture: uname.stdout.trim() || 'inconnue',
  };
}

// ─── un modèle ────────────────────────────────────────────────────────────────

type Outcome = 'ok' | 'failed' | 'architecture';

type Result = {
  template: CatalogTemplate;
  outcome: Outcome;
  /** L'étape où ça s'est arrêté, ou ce qui a répondu. */
  detail: string;
  seconds: number;
  images: string[];
  /** Les dernières lignes du driver, pour comprendre un échec sans relancer. */
  tail: string[];
};

/** Une image sans variante pour l'architecture de la cible : `docker pull` le dit ainsi. */
const NO_PLATFORM =
  /no matching manifest for|does not provide the specified platform|image with reference .* was found but does not match the specified platform|exec format error/i;

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

function contextFor(target: Target, spec: AppSpec, applicationId: string): DriverContext {
  return {
    spec,
    target: {
      id: target.id,
      name: target.name,
      host: target.host,
      rootPath: process.env.DRIVER_ROOT_PATH ?? '/opt/bootstrap',
    },
    deployment: { id: `catalog-${spec.name}-${Date.now()}`, version: spec.version, sequence: 1 },
    sshSession: target.session,
    appSlug: spec.name,
    applicationId,
    portAllocator: createPortAllocator(),
    // Des valeurs fraîches pour chaque secret, demandé ou non : ici, on prouve
    // que l'application démarre, pas qu'on retient un mot de passe.
    resolveSecrets: (names) =>
      Promise.resolve(
        Object.fromEntries(names.map((name) => [name, randomBytes(24).toString('base64url')])),
      ),
    additionalFiles: [],
    ...(process.env.DRIVER_PORT_RANGE
      ? {
          portRange: (() => {
            const [min, max] = process.env.DRIVER_PORT_RANGE.split('-').map(Number);
            return { min: min ?? 30_000, max: max ?? 32_767 };
          })(),
        }
      : {}),
  };
}

/** Une requête HTTP **depuis la cible**, seule à joindre le port publié à coup sûr. */
async function probe(
  session: SshSession,
  port: number,
  path: string,
): Promise<{ status: number | null; url: string }> {
  const url = `http://127.0.0.1:${port}${path}`;
  const result = await exec(session, `curl -s -o /dev/null -w '%{http_code}' -m 20 '${url}'`, {
    timeout: 40_000,
  });
  const status = Number.parseInt(result.stdout.trim().split('\n').pop() ?? '', 10);
  return { status: Number.isNaN(status) || status === 0 ? null : status, url };
}

async function checkTemplate(
  template: CatalogTemplate,
  target: Target,
  driver: DeploymentDriver,
): Promise<Result> {
  const started = Date.now();
  const tail: string[] = [];
  const onLog = (line: string) => {
    tail.push(line);
    if (tail.length > 40) tail.shift();
    write(`      ${dim(line.slice(0, 160))}\n`);
  };

  const spec = instantiateCatalogTemplate(template, {
    name: `cat-${template.id}`,
    host: null,
    tls: false,
    email: 'catalogue@pupitre.test',
  });
  const images = spec.services.flatMap((service) =>
    service.source.type === 'image' ? [service.source.ref] : [],
  );
  const exposed = spec.services.find((service) => service.exposed);
  const applicationId = await ensureApplication(spec);
  const ctx = contextFor(target, spec, applicationId);

  const finish = (outcome: Outcome, detail: string): Result => ({
    template,
    outcome,
    detail,
    seconds: Math.round((Date.now() - started) / 1000),
    images,
    tail: [...tail],
  });

  let result: Result;
  let stage = 'allocatePort()';
  try {
    const allocated = await driver.allocatePort(ctx);
    stage = 'render()';
    const artifacts = await driver.render(ctx);
    stage = 'upload()';
    await driver.upload(ctx, artifacts, onLog);
    stage = 'build()';
    await driver.build(ctx, onLog);
    stage = 'deploy()';
    const deployed = await driver.deploy(ctx, onLog);
    const port = deployed.publishedPort ?? allocated;
    stage = 'healthcheck()';
    const health = await driver.healthcheck(ctx);
    if (!health.healthy) {
      result = finish('failed', `sonde du driver : ${health.detail ?? 'en échec'}`);
    } else if (port === null) {
      result = finish('failed', "le driver n'a publié aucun port à sonder");
    } else {
      stage = 'requête HTTP';
      const answer = await probe(target.session, port, exposed?.healthcheck.path ?? '/');
      result =
        answer.status !== null && answer.status >= 200 && answer.status < 400
          ? finish('ok', `HTTP ${answer.status} — ${answer.url}`)
          : finish('failed', `HTTP ${answer.status ?? 'sans réponse'} — ${answer.url}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const platform = [message, ...tail].some((line) => NO_PLATFORM.test(line));
    result = platform
      ? finish('architecture', `pas d'image ${target.architecture} — ${message.split('\n')[0]}`)
      : finish('failed', `${stage} : ${message.split('\n')[0]}`);
  }

  // Le ménage, quoi qu'il soit arrivé : un modèle raté ne doit pas gêner le suivant.
  try {
    await driver.destroy(ctx, onLog);
  } catch (error) {
    write(
      `      ${yellow(`destroy : ${error instanceof Error ? error.message : String(error)}`)}\n`,
    );
  }
  const leftovers = await exec(
    target.session,
    `docker ps -a --filter 'label=tp.app=${spec.name}' --format '{{.Names}}'`,
    { timeout: 30_000 },
  );
  if (leftovers.stdout.trim() && result.outcome === 'ok') {
    result = {
      ...result,
      outcome: 'failed',
      detail: `restes après destroy : ${leftovers.stdout.trim()}`,
    };
  }
  await getDb().delete(applications).where(eq(applications.id, applicationId));
  return result;
}

// ─── récapitulatif ────────────────────────────────────────────────────────────

function summary(results: Result[], target: Target): boolean {
  const width = Math.max(...results.map((result) => result.template.id.length), 'Modèle'.length);
  write(
    `\n${bold(`Récapitulatif — catalogue sur ${target.name} (${target.runtime}, ${target.architecture})`)}\n\n`,
  );
  for (const result of results) {
    const mark =
      result.outcome === 'ok'
        ? green('✓')
        : result.outcome === 'architecture'
          ? yellow('N/A')
          : red('✗');
    write(
      `  ${mark.padEnd(12)} ${result.template.id.padEnd(width + 2)}${String(result.seconds).padStart(4)} s  ${dim(result.detail)}\n`,
    );
  }
  const ok = results.filter((result) => result.outcome === 'ok').length;
  const skipped = results.filter((result) => result.outcome === 'architecture').length;
  const failed = results.filter((result) => result.outcome === 'failed');
  write(
    `\n  ${ok}/${results.length - skipped} modèle(s) déployé(s) et joignable(s)` +
      (skipped > 0 ? `, ${skipped} sans image ${target.architecture} (hors décompte)` : '') +
      '\n',
  );
  for (const result of failed) {
    write(`\n${red(bold(`✗ ${result.template.id}`))} — ${result.detail}\n`);
    for (const line of result.tail.slice(-12)) write(`    ${dim(line.slice(0, 200))}\n`);
  }
  return failed.length === 0;
}

function markdownReport(results: Result[], target: Target): string {
  const date = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const label = {
    ok: '✅ répond',
    failed: '❌ échec',
    architecture: '➖ sans image pour cette architecture',
  };
  const rows = results.map(
    (result) =>
      `| ${result.template.name} | \`${result.images.join('`, `')}\` | ${label[result.outcome]} | ${result.seconds} s | ${result.detail.replace(/\|/g, '\\|')} |`,
  );
  return [
    `# Vérification du catalogue`,
    '',
    `${date} UTC — cible \`${target.name}\`, runtime ${target.runtime}, architecture ${target.architecture}.`,
    '',
    'Chaque modèle déployé par le driver, sondé, requêté en HTTP depuis la cible sur son chemin de santé, puis détruit.',
    '',
    '| Modèle | Images | Résultat | Durée | Détail |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const templates = CATALOG_TEMPLATES.filter(
    (template) =>
      (options.only === null || options.only.includes(template.id)) &&
      !options.skip.includes(template.id),
  );
  if (templates.length === 0) {
    write('Aucun modèle à vérifier avec ces filtres.\n');
    process.exitCode = 1;
    return;
  }

  write(`\n${bold('1. La cible')}\n`);
  const target = await openTarget(options.target, options.runtime);
  const driver = getDriver(target.runtime);
  write(
    `  ${green('OK')} ${target.name} (${target.host}) — ${target.runtime}, ${target.architecture}\n`,
  );

  const results: Result[] = [];
  try {
    const first = templates[0] as CatalogTemplate;
    const preflightSpec = instantiateCatalogTemplate(first, {
      name: `cat-${first.id}`,
      host: null,
      tls: false,
      email: 'catalogue@pupitre.test',
    });
    const preflight = await driver.preflight(
      contextFor(target, preflightSpec, await ensureApplication(preflightSpec)),
    );
    await getDb().delete(applications).where(eq(applications.slug, preflightSpec.name));
    if (!preflight.ok) {
      for (const check of preflight.checks) {
        write(`  ${check.ok ? green('✓') : red('✗')} ${check.label} — ${check.detail ?? ''}\n`);
      }
      throw new Error('preflight en échec : la cible ne peut rien déployer');
    }
    write(`  ${green('OK')} preflight — ${preflight.runtimeVersion ?? ''}\n`);

    for (const [index, template] of templates.entries()) {
      write(`\n${bold(`${index + 2}. ${template.name}`)} ${dim(`(${template.id})`)}\n`);
      const result = await checkTemplate(template, target, driver);
      results.push(result);
      const mark =
        result.outcome === 'ok'
          ? green('OK')
          : result.outcome === 'architecture'
            ? yellow('N/A')
            : red('KO');
      write(`  ${mark} ${result.detail} ${dim(`(${result.seconds} s)`)}\n`);
      if (options.pruneImages) {
        await exec(target.session, 'docker image prune -af >/dev/null 2>&1 || true', {
          timeout: 120_000,
        });
      }
    }

    const allGreen = summary(results, target);
    if (options.report) {
      writeFileSync(options.report, markdownReport(results, target));
      write(`\n  ${dim(`rapport écrit dans ${options.report}`)}\n`);
    }
    write(
      allGreen
        ? `\n${green(bold('Catalogue vérifié : chaque modèle démarre et répond.'))}\n\n`
        : `\n${red(bold('Catalogue NON vérifié.'))}\n\n`,
    );
    if (!allGreen) process.exitCode = 1;
  } finally {
    await disconnect(target.session);
    await closeDb();
  }
}

main().catch((error: unknown) => {
  write(`\n${red(error instanceof Error ? (error.stack ?? error.message) : String(error))}\n`);
  process.exitCode = 1;
  void closeDb();
});
