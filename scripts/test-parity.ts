/**
 * LE TEST DE VÉRITÉ du jalon 5.
 *
 * Une seule AppSpec, deux runtimes. Si un champ doit être modifié entre les deux
 * déploiements, l'abstraction a échoué et ce script doit le dire.
 *
 *   pnpm test:parity <cible-docker> <cible-k3s> [--spec fichier.json] [--keep]
 *
 * Déroulé :
 *   1. une application créée depuis `fullstack.json`
 *   2. déployée sur la cible Docker  → l'URL doit répondre 200
 *   3. déployée sur la cible K3s, **même AppSpec, sans une modification**
 *   4. rollback des deux            → les deux URL répondent toujours
 *   5. destroy des deux             → plus rien ne tourne, le port Docker est
 *      libéré, le namespace K3s a disparu
 *
 * Sortie en code 1 dès qu'un seul point échoue.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decrypt, parseAppSpec, type AppSpec, type Service } from '@tp/core';
import {
  getDriver,
  type DeploymentDriver,
  type DriverContext,
  type DriverDeployment,
  type RenderedFile,
  type RuntimeKind,
} from '@tp/core/drivers';
import { connect, disconnect, exec, type SshSession, type SshTarget } from '@tp/core/ssh';
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
const DEFAULT_SPEC = path.join(ROOT, 'packages/core/src/spec/__fixtures__/fullstack.json');

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

// ─── tableau récapitulatif ────────────────────────────────────────────────────

type Check = {
  phase: string;
  runtime: RuntimeKind | 'les deux';
  label: string;
  ok: boolean;
  detail: string;
};

const checks: Check[] = [];

function record(check: Check): boolean {
  checks.push(check);
  write(
    `  ${check.ok ? green('OK') : red('KO')} [${check.runtime}] ${check.label}` +
      `${check.detail ? ` ${dim(`— ${check.detail}`)}` : ''}\n`,
  );
  return check.ok;
}

/** Exécute une phase en transformant une exception en échec tracé. */
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
      'Usage : pnpm test:parity <cible-docker> <cible-k3s> [--spec fichier.json] [--keep]\n\n' +
        'Les deux cibles sont des noms ou des UUID de cibles enregistrées.\n',
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

// ─── contextes de build ───────────────────────────────────────────────────────

/**
 * Les services à Dockerfile ont besoin de leurs sources sur la cible. En
 * production c'est le pipeline qui les fournit ; ici on les fabrique, à
 * l'identique pour les deux runtimes — c'est tout l'intérêt du test.
 *
 * L'image est volontairement minimale et **non privilégiée** : elle doit tenir
 * sous le `securityContext` strict imposé par le driver K3s (uid 1000, racine en
 * lecture seule) comme sous Docker Compose.
 */
function buildContexts(spec: AppSpec): RenderedFile[] {
  const files: RenderedFile[] = [];

  for (const service of spec.services) {
    if (service.source.type !== 'dockerfile') continue;

    const context = service.source.context.replace(/^\.\//, '').replace(/\/$/, '');
    const probePath = service.healthcheck.path;
    const directory = probePath.slice(0, probePath.lastIndexOf('/'));

    files.push({
      path: `${context}/${service.source.dockerfile}`,
      content: dockerfileFor(service, directory, probePath),
      mode: 0o644,
    });
  }

  return files;
}

function dockerfileFor(service: Service, directory: string, probePath: string): string {
  return [
    '# Contexte de build synthétique, produit par scripts/test-parity.ts.',
    `# Service « ${service.name} » — écoute sur ${service.port}, répond sur ${probePath}.`,
    'FROM busybox:1.36',
    `RUN mkdir -p /www${directory} \\`,
    `  && printf 'ok\\n' > /www${probePath} \\`,
    `  && printf '<h1>${service.name}</h1>\\n' > /www/index.html`,
    'USER 1000:1000',
    `EXPOSE ${service.port}`,
    `CMD ["httpd", "-f", "-v", "-p", "${service.port}", "-h", "/www"]`,
    '',
  ].join('\n');
}

// ─── infrastructure ───────────────────────────────────────────────────────────

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

type Side = {
  runtime: RuntimeKind;
  driver: DeploymentDriver;
  ctx: DriverContext;
  session: SshSession;
  targetName: string;
  targetHost: string;
  /** Renseigné par la phase de déploiement. */
  url: string | null;
  publishedPort: number | null;
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
      `Cible « ${targetRef} » introuvable. Cibles connues : ` +
        (all.map((target) => target.name).join(', ') || 'aucune'),
    );
  }

  const record_ = await getTargetSecret(found.id);
  if (!record_) throw new Error(`Impossible de relire la cible ${found.id}`);

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

  const session = await connect(sshTarget);
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
    appSlug: spec.name,
    applicationId,
    // Le rollback ramène vers la même version : ce script ne déploie qu'une fois.
    previousDeployment: { id: 'parity-previous', version: spec.version, sequence: 0 },
    portAllocator: createPortAllocator(),
    /**
     * Valeurs de remplissage pour les secrets déclarés.
     *
     * Ce script pilote les drivers en direct : il n'a ni application en base,
     * ni magasin de secrets. Or le rendu refuse désormais un secret déclaré
     * sans valeur — à raison, c'est ce qui empêche un `.env` vide de partir
     * sur une machine. Ici la valeur n'a aucune importance : on compare deux
     * runtimes, pas la résolution des secrets. Les deux côtés reçoivent la
     * même, ce qui rend d'ailleurs la comparaison plus franche.
     */
    resolveSecrets: (names) =>
      Promise.resolve(
        Object.fromEntries(names.map((name) => [name, `valeur-de-parite-${name.toLowerCase()}`])),
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

  return {
    runtime,
    driver: getDriver(runtime),
    ctx,
    session,
    targetName: found.name,
    targetHost: found.host,
    url: null,
    publishedPort: null,
  };
}

// ─── sonde HTTP ───────────────────────────────────────────────────────────────

/**
 * Sonde l'URL **depuis la cible**, seul endroit d'où elle est joignable à coup
 * sûr : le poste qui lance ce script n'a ni le DNS de l'application, ni de route
 * vers le réseau interne du cluster.
 *
 * La commande n'a rien de spécifique à un runtime : elle se déduit de ce que le
 * driver a répondu — une URL avec un nom de domaine, ou un port publié.
 */
async function probeFromTarget(
  side: Side,
  probePath: string,
): Promise<{ status: number | null; detail: string }> {
  const url = side.url ?? (side.publishedPort ? `http://127.0.0.1:${side.publishedPort}` : null);
  if (!url) {
    return { status: null, detail: "le driver n'a annoncé ni URL ni port publié" };
  }

  const parsed = new URL(url);
  const target = new URL(probePath, parsed).toString();
  const isName = !/^\d+\.\d+\.\d+\.\d+$/.test(parsed.hostname) && parsed.hostname !== 'localhost';
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');

  // `--resolve` : le nom de domaine de l'AppSpec n'a aucune raison d'exister
  // dans le DNS de la cible. On l'épingle sur la boucle locale, là où le proxy
  // (Traefik en Docker, contrôleur d'ingress en K3s) écoute.
  const resolve = isName ? `--resolve '${parsed.hostname}:${port}:127.0.0.1' ` : '';
  const command = `curl -s -k -o /dev/null -w '%{http_code}' -m 15 ${resolve}'${target}'`;

  const result = await exec(side.session, command, { timeout: 30_000 });
  const status = Number.parseInt(result.stdout.trim().split('\n').pop() ?? '', 10);

  return {
    status: Number.isNaN(status) || status === 0 ? null : status,
    detail: command,
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

  // Le seul écart attendu entre les deux runtimes, et il vient du driver.
  // `guarded` renvoie `null` en cas d'exception : on emballe la réponse pour ne
  // pas confondre « le driver a répondu null » et « le driver a échoué ».
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
        ? "null — exposition par Ingress, l'étape serait « skipped »"
        : `port ${allocation.port} réservé`,
  });

  const artifacts = await guarded('deploy', runtime, 'render()', () => driver.render(ctx));
  if (!artifacts) return;
  record({
    phase: 'deploy',
    runtime,
    label: 'render()',
    ok: artifacts.files.length > 0,
    detail: `${artifacts.projectName} — ${artifacts.files.length} fichier(s)`,
  });
  for (const file of artifacts.files) info(`${file.path} — ${file.content.length} octets`);

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
        ? "rien à construire — l'étape serait « skipped »"
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
    detail: result.url ?? 'sans URL publique',
  });

  const health = await guarded('deploy', runtime, 'healthcheck()', () => driver.healthcheck(ctx));
  record({
    phase: 'deploy',
    runtime,
    label: 'healthcheck()',
    ok: health?.healthy === true,
    detail: health?.detail ?? 'sans détail',
  });

  const probe = await probeFromTarget(side, probePath);
  record({
    phase: 'deploy',
    runtime,
    label: "l'URL répond 200",
    ok: probe.status !== null && probe.status >= 200 && probe.status < 400,
    detail: probe.status === null ? probe.detail : `HTTP ${probe.status}`,
  });
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

  const health = await guarded('rollback', runtime, 'santé après rollback', () =>
    driver.healthcheck(ctx),
  );
  record({
    phase: 'rollback',
    runtime,
    label: 'santé après rollback',
    ok: health?.healthy === true,
    detail: health?.detail ?? 'sans détail',
  });

  const probe = await probeFromTarget(side, probePath);
  record({
    phase: 'rollback',
    runtime,
    label: "l'URL répond toujours",
    ok: probe.status !== null && probe.status >= 200 && probe.status < 400,
    detail: probe.status === null ? probe.detail : `HTTP ${probe.status}`,
  });
}

async function destroySide(side: Side): Promise<void> {
  const { driver, ctx, runtime } = side;
  const emit = (line: string) => write(`      ${dim(line)}\n`);

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
    label: 'artefacts supprimés de la cible',
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
    label: 'aucun port réservé en base',
    ok: (allocated ?? null) === null,
    detail: allocated === null || allocated === undefined ? 'libéré' : `port ${allocated} restant`,
  });

  // Un script de test a le droit de connaître les deux runtimes ; le pipeline,
  // lui, ne le doit jamais. C'est la seule vérification asymétrique du fichier.
  const residue =
    runtime === 'k3s'
      ? {
          label: 'namespace K3s disparu',
          command:
            'if [ -z "${KUBECONFIG:-}" ] && [ -r /etc/rancher/k3s/k3s.yaml ]; ' +
            'then KUBECONFIG=/etc/rancher/k3s/k3s.yaml; export KUBECONFIG; fi\n' +
            `kubectl get namespace app-${ctx.appSlug} --no-headers 2>/dev/null`,
        }
      : {
          label: 'aucun conteneur Docker restant',
          command: `docker ps -a --filter 'label=tp.app=${ctx.appSlug}' --format '{{.Names}}'`,
        };

  const check = await exec(side.session, residue.command, { timeout: 30_000 });
  record({
    phase: 'destroy',
    runtime,
    label: residue.label,
    ok: check.stdout.trim().length === 0,
    detail: check.stdout.trim() || 'rien ne subsiste',
  });
}

// ─── récapitulatif ────────────────────────────────────────────────────────────

function summary(): boolean {
  const phases = ['deploy', 'rollback', 'destroy'];
  const labels = [...new Set(checks.map((check) => `${check.phase} ${check.label}`))];

  const width = Math.max(
    ...labels.map((key) => (key.split(' ')[1] ?? '').length),
    'Vérification'.length,
  );

  write(`\n${bold('Récapitulatif — une AppSpec, deux runtimes')}\n\n`);
  write(`  ${'Phase'.padEnd(9)}${'Vérification'.padEnd(width + 2)}${'docker'.padEnd(9)}k3s\n`);
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
  write(`\n  ${checks.length - failed.length}/${checks.length} vérification(s) au vert\n`);

  if (failed.length > 0) {
    write(`\n${red(bold('Échecs :'))}\n`);
    for (const check of failed) {
      write(`  ${red('✗')} [${check.runtime}] ${check.phase} — ${check.label}\n`);
      if (check.detail) write(`      ${dim(check.detail)}\n`);
    }
  }

  return failed.length === 0;
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  step('1. Une seule AppSpec');
  const spec = parseAppSpec(JSON.parse(readFileSync(options.specPath, 'utf8')));
  write(
    `  ${green('OK')} ${spec.name} v${spec.version} — ${spec.services.length} service(s)\n`,
  );
  info(path.relative(ROOT, options.specPath));
  info('Cette spec ne sera pas modifiée entre les deux runtimes. C’est tout le test.');

  const contexts = buildContexts(spec);
  if (contexts.length > 0) {
    info(`contextes de build fournis : ${contexts.map((file) => file.path).join(', ')}`);
  }

  const applicationId = await ensureApplication(spec);
  const sides: Side[] = [];

  try {
    step('2. Ouverture des deux cibles');
    for (const [runtime, ref] of [
      ['docker', options.dockerTarget],
      ['k3s', options.k3sTarget],
    ] as Array<[RuntimeKind, string]>) {
      const side = await openSide(runtime, ref, spec, applicationId, contexts);
      sides.push(side);
      write(`  ${green('OK')} ${runtime} → ${side.targetName} (${side.targetHost})\n`);
    }

    const probePath = spec.ingress
      ? (spec.services.find((service) => service.name === spec.ingress?.targetService)
          ?.healthcheck.path ?? '/')
      : (spec.services.find((service) => service.exposed)?.healthcheck.path ?? '/');

    for (const side of sides) {
      step(`3. Déploiement sur ${side.targetName} — runtime ${side.runtime}`);
      await deploySide(side, probePath);
    }

    for (const side of sides) {
      step(`4. Rollback sur ${side.targetName} — runtime ${side.runtime}`);
      await rollbackSide(side, probePath);
    }

    if (options.keep) {
      step('5. Destroy — sauté (--keep)');
      info(
        `Nettoyage : pnpm test:parity ${options.dockerTarget} ${options.k3sTarget}` +
          ' (sans --keep) relancera un cycle complet.',
      );
    } else {
      for (const side of sides) {
        step(`5. Destroy sur ${side.targetName} — runtime ${side.runtime}`);
        await destroySide(side);
      }
    }

    const allGreen = summary();
    if (allGreen) {
      write(
        `\n${green(bold('Parité vérifiée : la même AppSpec tourne sur les deux runtimes.'))}\n\n`,
      );
    } else {
      write(`\n${red(bold('Parité NON vérifiée.'))}\n\n`);
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
