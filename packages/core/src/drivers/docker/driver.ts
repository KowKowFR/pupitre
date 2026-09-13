import { PORT_RANGE_MAX, PORT_RANGE_MIN } from '../../ports.js';
import type { AppStatus, ServiceState, ServiceStatus } from '../../supervision.js';
import { exec, execStream, upload } from '../../ssh/client.js';
import { exposedService, storedSecretNames, type AppSpec } from '../../spec/index.js';
import { backoffMs } from '../backoff.js';
import { listeningPorts } from '../listening.js';
import { pruneReleases } from '../retention.js';
import { ufwAllow, ufwDelete } from '../ufw.js';
import {
  DriverError,
  type DeployResult,
  type DeploymentDriver,
  type DriverContext,
  type HealthOutcome,
  type HealthResult,
  type LogSink,
  type PreflightResult,
  type RenderedArtifacts,
  type RenderedFile,
  type TargetContext,
} from '../types.js';
import { managedWorkloadRefusal, type Workload, type WorkloadRef } from '../../workloads.js';
import { PROJECT_PREFIX, buildImageTag, projectName, renderFiles } from './render.js';

/**
 * Driver Docker Compose.
 *
 * Il n'importe rien de `packages/db`, rien de `apps/web`, rien de Redis. Tout
 * arrive par `DriverContext` — y compris la réservation de ports, qui passe par
 * l'interface `PortAllocator` dont l'implémentation vit ailleurs.
 *
 * Isolation : un projet Compose par application, préfixé `app-{slug}`, avec son
 * propre réseau bridge et ses propres volumes nommés.
 */

const BUILD_TIMEOUT_MS = 20 * 60_000;
/** Tentatives d'allocation avant d'admettre que la plage est inutilisable. */
const ATTEMPTS_PORT = 20;
const UP_TIMEOUT_MS = 10 * 60_000;
const SHORT_TIMEOUT_MS = 30_000;
/** Lignes de logs remontées par service quand le healthcheck échoue. */
const DIAGNOSTIC_LINES = 200;
const DIAGNOSTIC_TIMEOUT_MS = 60_000;
/** Tirer une image peut prendre plusieurs minutes sur un lien lent. */
const PULL_TIMEOUT_MS = 10 * 60_000;
const REMOVE_TIMEOUT_MS = 2 * 60_000;
/** Sépare deux sorties dans une même invocation shell. */
const SENTINEL = '---tp-workloads---';

export class DockerComposeDriver implements DeploymentDriver {
  readonly runtime = 'docker' as const;

  /** Le projet Compose sous lequel l'application est regroupée sur la cible. */
  workspaceName(appSlug: string): string {
    return projectName(appSlug);
  }

  /** Le décalque exact de `destroy()`, à passer à la main sur la machine. */
  manualCleanup(appSlug: string, rootPath: string): string[] {
    const appPath = `${rootPath}/apps/${appSlug}`;
    return [
      `cd ${appPath}/current && docker compose down -v --remove-orphans`,
      `rm -rf ${appPath}`,
    ];
  }

  /** `/opt/bootstrap/apps/{slug}` */
  private appPath(ctx: DriverContext): string {
    return `${ctx.target.rootPath}/apps/${ctx.appSlug}`;
  }

  /** `/opt/bootstrap/apps/{slug}/{version}` */
  private releasePath(ctx: DriverContext, version = ctx.deployment.version): string {
    return `${this.appPath(ctx)}/${version}`;
  }

  private project(ctx: DriverContext): string {
    return projectName(ctx.appSlug);
  }

  /** `docker compose` exécuté dans le répertoire d'une release. */
  private compose(ctx: DriverContext, args: string, version?: string): string {
    return `cd ${shellQuote(this.releasePath(ctx, version))} && docker compose ${args}`;
  }

  // ─── preflight ──────────────────────────────────────────────────────────────

  async preflight(ctx: DriverContext): Promise<PreflightResult> {
    const checks: PreflightResult['checks'] = [];

    const info = await exec(ctx.sshSession, "docker info --format '{{.ServerVersion}}'", {
      timeout: SHORT_TIMEOUT_MS,
    });
    const runtimeVersion = info.code === 0 ? firstLine(info.stdout) : null;
    checks.push({
      key: 'docker_info',
      label: 'Daemon Docker',
      ok: runtimeVersion !== null,
      detail: runtimeVersion ?? firstLine(info.stderr) ?? `code ${info.code}`,
    });

    const compose = await exec(ctx.sshSession, 'docker compose version --short', {
      timeout: SHORT_TIMEOUT_MS,
    });
    const composeVersion = compose.code === 0 ? firstLine(compose.stdout) : null;
    checks.push({
      key: 'docker_compose',
      label: 'Docker Compose',
      ok: composeVersion !== null,
      detail: composeVersion ?? firstLine(compose.stderr) ?? `code ${compose.code}`,
    });

    // `df` sur le parent existant le plus proche : la racine du driver peut ne
    // pas encore exister sur une cible neuve.
    const disk = await exec(
      ctx.sshSession,
      `df -Pk ${shellQuote(ctx.target.rootPath)} 2>/dev/null || df -Pk /`,
      { timeout: SHORT_TIMEOUT_MS },
    );
    const availableDiskMi = parseAvailableMi(disk.stdout);
    const enoughDisk = availableDiskMi !== null && availableDiskMi >= 1024;
    checks.push({
      key: 'disk',
      label: 'Espace disque',
      ok: enoughDisk,
      detail:
        availableDiskMi === null
          ? 'sortie de df illisible'
          : `${Math.round(availableDiskMi / 1024)} Gio disponibles`,
    });

    const workdir = await this.ensureWorkdir(ctx);
    checks.push({
      key: 'workdir',
      label: 'Répertoire de travail',
      ok: workdir.ok,
      detail: workdir.detail,
    });

    return {
      ok: checks.every((check) => check.ok),
      runtimeVersion,
      availableDiskMi,
      checks,
    };
  }

  /**
   * Garantit que la racine du driver est écrivable par le compte de déploiement.
   *
   * `/opt` appartient à root sur une machine standard : le premier passage a
   * besoin d'une élévation pour créer l'arborescence et la donner au compte.
   * Les suivants n'en ont plus besoin, et une cible déjà provisionnée n'en a
   * jamais besoin.
   */
  private async ensureWorkdir(
    ctx: DriverContext,
  ): Promise<{ ok: boolean; detail: string | null }> {
    const appPath = this.appPath(ctx);
    const direct = await exec(
      ctx.sshSession,
      `mkdir -p ${shellQuote(appPath)} && test -w ${shellQuote(appPath)}`,
      { timeout: SHORT_TIMEOUT_MS },
    );
    if (direct.code === 0) return { ok: true, detail: appPath };

    // L'identité doit être résolue AVANT l'élévation : sous `sudo`, `id -u`
    // répondrait 0 et le chown donnerait l'arborescence à root.
    const identity = await exec(ctx.sshSession, 'id -u; id -g', {
      timeout: SHORT_TIMEOUT_MS,
    });
    const [uid, gid] = identity.stdout.trim().split('\n').map((value) => value.trim());
    if (identity.code !== 0 || !uid || !gid) {
      return { ok: false, detail: "impossible de résoudre l'identité du compte de déploiement" };
    }

    const elevated = await exec(
      ctx.sshSession,
      `mkdir -p ${shellQuote(appPath)} && chown -R ${uid}:${gid} ${shellQuote(ctx.target.rootPath)}`,
      { sudo: true, timeout: SHORT_TIMEOUT_MS },
    );
    if (elevated.code !== 0) {
      return {
        ok: false,
        detail:
          firstLine(elevated.stderr) ??
          firstLine(direct.stderr) ??
          `${ctx.target.rootPath} n'est pas écrivable et sudo a échoué`,
      };
    }

    // On revérifie plutôt que de faire confiance au code de retour : c'est
    // l'écriture qui compte, pas le succès apparent du chown.
    const confirmed = await exec(ctx.sshSession, `test -w ${shellQuote(appPath)}`, {
      timeout: SHORT_TIMEOUT_MS,
    });
    return confirmed.code === 0
      ? { ok: true, detail: `${appPath} (provisionné via sudo)` }
      : { ok: false, detail: `${appPath} reste non écrivable après élévation` };
  }

  // ─── allocatePort ───────────────────────────────────────────────────────────

  /**
   * L'unicité entre applications du panel est portée par la contrainte
   * `(target_id, port)` en base. Le driver ne teste rien là-dessus : il
   * demande, la base tranche.
   *
   * Reste ce que la base ne peut pas savoir — un service installé à la main sur
   * la cible qui écoute déjà sur le port tiré. On le constate après coup, on
   * déclare l'allocation morte, et on reprend en excluant ce port. Une
   * réservation déjà acquise par cette application n'est jamais remise en
   * cause : le port est occupé, oui, mais par nous.
   */
  async allocatePort(ctx: DriverContext, onLog?: LogSink): Promise<number | null> {
    if (!ctx.portAllocator) {
      throw new DriverError(
        'allocatePort exige un `portAllocator` dans le contexte',
        this.runtime,
        'allocate_port',
      );
    }

    const allocator = ctx.portAllocator;
    const key = { targetId: ctx.target.id, applicationId: ctx.applicationId };
    const log = onLog ?? (() => {});

    const existing = await allocator.current(key);
    if (existing !== null) return existing;

    const range = {
      min: ctx.portRange?.min ?? PORT_RANGE_MIN,
      max: ctx.portRange?.max ?? PORT_RANGE_MAX,
    };

    // Une seule sonde pour toute la boucle : l'état des ports de la cible ne
    // change pas pendant les quelques millisecondes d'un retry.
    const inUse = await listeningPorts(ctx);
    if (inUse === null) {
      log('⚠ ni ss ni netstat sur la cible — impossible de vérifier les ports déjà en écoute');
    }

    const dead: number[] = [];

    for (let attempt = 0; attempt < ATTEMPTS_PORT; attempt += 1) {
      const port = await allocator.allocate({ ...key, ...range, exclude: dead });

      if (inUse === null || !inUse.has(port)) {
        if (dead.length > 0) {
          log(`port ${port} réservé après ${dead.length} port(s) écarté(s)`);
        }
        return port;
      }

      // Réservation morte : la base nous l'a accordée, la cible dit le
      // contraire. On la relâche pour ne pas immobiliser un port dont nous ne
      // ferons rien, et on l'écarte du prochain tirage.
      log(`⚠ port ${port} déjà en écoute sur ${ctx.target.name} — réservation abandonnée`);
      await allocator.release(key);
      dead.push(port);
    }

    throw new DriverError(
      `Aucun port libre entre ${range.min} et ${range.max} sur « ${ctx.target.name} » : ` +
        `${dead.length} port(s) réservés en base se sont révélés occupés (${dead.join(', ')}).`,
      this.runtime,
      'allocate_port',
    );
  }

  // ─── pare-feu ───────────────────────────────────────────────────────────────

  /**
   * Ouvre le port sur UFW.
   *
   * Le `DockerComposeDriver` publie sur une interface de la machine : le
   * pare-feu la concerne. Le `K3sDriver`, lui, n'implémente pas ces méthodes du
   * tout — l'exposition y passe par l'Ingress. Le pipeline appelle si la
   * méthode existe, sans jamais regarder de quel runtime il s'agit.
   */
  async openFirewall(ctx: DriverContext, port: number, onLog?: LogSink): Promise<void> {
    await ufwAllow(ctx, port, onLog ?? (() => {}));
  }

  async closeFirewall(ctx: DriverContext, port: number, onLog?: LogSink): Promise<void> {
    await ufwDelete(ctx, port, onLog ?? (() => {}));
  }

  // ─── render ─────────────────────────────────────────────────────────────────

  async render(ctx: DriverContext): Promise<RenderedArtifacts> {
    const publishedPort = await this.resolvePublishedPort(ctx);
    // Les racines seulement : un alias n'a pas de valeur propre à demander.
    const secretNames = storedSecretNames(ctx.spec);
    const secretValues = ctx.resolveSecrets ? await ctx.resolveSecrets(secretNames) : {};

    const files = renderFiles({
      spec: ctx.spec,
      appSlug: ctx.appSlug,
      publishedPort,
      secretValues,
    });

    return { projectName: this.project(ctx), files, publishedPort };
  }

  /**
   * Compose ne sait pas répartir un port publié entre plusieurs répliques.
   * Au-delà d'une réplique, l'exposition doit passer par le proxy : le driver
   * ne publie alors aucun port et le dit.
   */
  private async resolvePublishedPort(ctx: DriverContext): Promise<number | null> {
    const exposed = exposedService(ctx.spec);
    if (exposed.replicas > 1) return null;

    if (ctx.portAllocator) {
      const existing = await ctx.portAllocator.current({
        targetId: ctx.target.id,
        applicationId: ctx.applicationId,
      });
      return existing ?? (await this.allocatePort(ctx));
    }
    return null;
  }

  // ─── upload ─────────────────────────────────────────────────────────────────

  async upload(
    ctx: DriverContext,
    artifacts: RenderedArtifacts,
    onLog: LogSink,
  ): Promise<void> {
    const release = this.releasePath(ctx);
    onLog(`projet ${artifacts.projectName}, release ${release}`);

    const workdir = await this.ensureWorkdir(ctx);
    if (!workdir.ok) {
      throw new DriverError(
        `Racine de déploiement inutilisable : ${workdir.detail ?? 'raison inconnue'}`,
        this.runtime,
        'upload',
      );
    }
    await this.run(ctx, `mkdir -p ${shellQuote(release)}`, onLog, 'upload');

    const files: RenderedFile[] = [...(ctx.additionalFiles ?? []), ...artifacts.files];
    for (const file of files) {
      await this.uploadFile(ctx, release, file, onLog);
    }

    await this.assertBuildContexts(ctx, release, onLog);
  }

  // ─── build ──────────────────────────────────────────────────────────────────

  /** `null` quand aucun service ne se construit : l'étape est alors `skipped`. */
  async build(ctx: DriverContext, onLog: LogSink): Promise<string[] | null> {
    const buildable = ctx.spec.services.filter(
      (service) => service.source.type === 'dockerfile',
    );
    if (buildable.length === 0) return null;

    onLog(`docker compose build (${buildable.map((s) => s.name).join(', ')})`);
    await this.stream(ctx, this.compose(ctx, 'build --pull'), onLog, 'build', BUILD_TIMEOUT_MS);

    return buildable.map((service) =>
      buildImageTag(ctx.appSlug, service.name, ctx.spec.version),
    );
  }

  // ─── images ─────────────────────────────────────────────────────────────────

  /**
   * Déduite de l'AppSpec, pas de la cible : la liste doit être connue avant que
   * quoi que ce soit ne tourne, pour que les scanners puissent l'analyser.
   */
  async images(ctx: DriverContext): Promise<string[]> {
    return ctx.spec.services.map((service) =>
      service.source.type === 'image'
        ? service.source.ref
        : buildImageTag(ctx.appSlug, service.name, ctx.spec.version),
    );
  }

  // ─── deploy ─────────────────────────────────────────────────────────────────

  async deploy(ctx: DriverContext, onLog: LogSink): Promise<DeployResult> {
    const release = this.releasePath(ctx);
    const publishedPort = await this.resolvePublishedPort(ctx);

    onLog('docker compose pull');
    // Un échec de pull n'est pas fatal : l'image peut déjà être sur la cible,
    // et une image construite localement n'existe dans aucun registry.
    await this.stream(
      ctx,
      this.compose(ctx, 'pull --ignore-pull-failures'),
      onLog,
      'pull',
      BUILD_TIMEOUT_MS,
      false,
    );

    onLog('docker compose up -d --remove-orphans');
    await this.stream(
      ctx,
      this.compose(ctx, 'up -d --remove-orphans --wait --wait-timeout 300'),
      onLog,
      'up',
      UP_TIMEOUT_MS,
    );

    // Marque la release courante : `rollback()` et `destroy()` s'en servent.
    await this.run(
      ctx,
      `ln -sfn ${shellQuote(release)} ${shellQuote(`${this.appPath(ctx)}/current`)}`,
      onLog,
      'link',
    );

    // Ménage des anciennes versions, une fois `current` à jour : c'est le seul
    // moment où l'on sait laquelle ne doit surtout pas partir.
    await pruneReleases(ctx, this.appPath(ctx), onLog);

    const images = await this.listImages(ctx);
    const url = this.buildUrl(ctx, publishedPort);

    onLog(`services démarrés${url ? ` — ${url}` : ''}`);

    return { ok: true, url, publishedPort, releasePath: release, images };
  }

  /** URL par laquelle l'application doit répondre. */
  private buildUrl(ctx: DriverContext, publishedPort: number | null): string | null {
    const ingress = ctx.spec.ingress;
    if (ingress?.host) {
      return `${ingress.tls ? 'https' : 'http'}://${ingress.host}`;
    }
    if (publishedPort === null) return null;
    return `http://${ctx.target.host}:${publishedPort}`;
  }

  /**
   * Un service à construire exige que son contexte de build ait été déposé.
   * Le driver ne va pas le chercher : il vérifie et échoue clairement.
   */
  private async assertBuildContexts(
    ctx: DriverContext,
    release: string,
    onLog: LogSink,
  ): Promise<void> {
    for (const service of ctx.spec.services) {
      if (service.source.type !== 'dockerfile') continue;

      const dockerfile = `${release}/${service.source.context}/${service.source.dockerfile}`;
      const check = await exec(ctx.sshSession, `test -f ${shellQuote(dockerfile)}`, {
        timeout: SHORT_TIMEOUT_MS,
      });
      if (check.code !== 0) {
        onLog(`✗ contexte de build absent pour « ${service.name} » : ${dockerfile}`);
        throw new DriverError(
          `Le service « ${service.name} » se construit depuis ${service.source.dockerfile}, ` +
            `mais le fichier est absent de ${release}/${service.source.context}. ` +
            'Le contexte de build doit être fourni via `additionalFiles`.',
          this.runtime,
          'build_context',
        );
      }
    }
  }

  private async uploadFile(
    ctx: DriverContext,
    release: string,
    file: RenderedFile,
    onLog: LogSink,
  ): Promise<void> {
    const remote = `${release}/${file.path}`;
    const directory = remote.slice(0, remote.lastIndexOf('/'));

    await this.run(ctx, `mkdir -p ${shellQuote(directory)}`, onLog, 'prepare');
    await upload(ctx.sshSession, Buffer.from(file.content, 'utf8'), remote);

    if (file.mode !== undefined) {
      await this.run(
        ctx,
        `chmod ${file.mode.toString(8).padStart(4, '0')} ${shellQuote(remote)}`,
        onLog,
        'prepare',
      );
    }
    // Le contenu n'est jamais journalisé : `.env` porte les secrets.
    onLog(`  déposé ${file.path} (${file.content.length} octets)`);
  }

  private async listImages(ctx: DriverContext): Promise<string[]> {
    const result = await exec(
      ctx.sshSession,
      this.compose(ctx, "config --images 2>/dev/null || true"),
      { timeout: SHORT_TIMEOUT_MS },
    );
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  // ─── healthcheck ────────────────────────────────────────────────────────────

  async healthcheck(ctx: DriverContext): Promise<HealthResult> {
    const service = exposedService(ctx.spec);
    const { retries, intervalSec, timeoutSec, path } = service.healthcheck;

    const ps = await exec(ctx.sshSession, this.compose(ctx, 'ps --format json'), {
      timeout: SHORT_TIMEOUT_MS,
    });
    const running = countRunning(ps.stdout);
    if (running === 0) {
      return this.unhealthy(ctx, {
        outcome: 'unreachable',
        attempts: 0,
        statusCode: null,
        detail: 'aucun conteneur en cours d’exécution',
      });
    }

    const publishedPort = await this.resolvePublishedPort(ctx);
    if (publishedPort === null) {
      // Sans port publié, la sonde HTTP depuis l'hôte n'a pas de cible :
      // on s'en remet à l'état des conteneurs, tenu par leur propre healthcheck.
      const unhealthy = await exec(
        ctx.sshSession,
        this.compose(ctx, "ps --format '{{.Health}}' | grep -c unhealthy || true"),
        { timeout: SHORT_TIMEOUT_MS },
      );
      const bad = Number.parseInt(firstLine(unhealthy.stdout) ?? '0', 10);
      const detail = `aucun port publié — ${running} conteneur(s), ${bad} en défaut`;

      return bad === 0
        ? { healthy: true, outcome: 'healthy', attempts: 1, statusCode: null, detail, diagnostics: null }
        : this.unhealthy(ctx, {
            outcome: 'unhealthy',
            attempts: 1,
            statusCode: null,
            detail,
          });
    }

    const url = `http://127.0.0.1:${publishedPort}${path}`;
    let lastStatus: number | null = null;
    let lastDetail: string | null = null;
    let lastOutcome: HealthOutcome = 'unreachable';

    for (let attempt = 1; attempt <= retries; attempt += 1) {
      const probe = await exec(
        ctx.sshSession,
        `curl -s -o /dev/null -w '%{http_code}' -m ${timeoutSec} ${shellQuote(url)}`,
        { timeout: (timeoutSec + 5) * 1000 },
      );

      const status = Number.parseInt(firstLine(probe.stdout) ?? '', 10);
      // `curl` écrit « 000 » quand il n'a rien obtenu : ce n'est pas un code
      // HTTP, c'est l'absence de réponse.
      lastStatus = Number.isNaN(status) || status === 0 ? null : status;
      lastOutcome = lastStatus === null ? 'unreachable' : 'unhealthy';
      lastDetail =
        lastStatus !== null
          ? `HTTP ${lastStatus} sur ${url}`
          : `${url} injoignable depuis la cible ` +
            `(curl code ${probe.code}${firstLine(probe.stderr) ? ` : ${firstLine(probe.stderr)}` : ''})`;

      if (lastStatus !== null && lastStatus >= 200 && lastStatus < 400) {
        return {
          healthy: true,
          outcome: 'healthy',
          attempts: attempt,
          statusCode: lastStatus,
          detail: url,
          diagnostics: null,
        };
      }

      if (attempt < retries) await sleep(backoffMs(intervalSec, attempt));
    }

    return this.unhealthy(ctx, {
      outcome: lastOutcome,
      attempts: retries,
      statusCode: lastStatus,
      detail: lastDetail,
    });
  }

  /**
   * Construit le résultat d'échec **après avoir capturé la scène**.
   *
   * L'ordre compte : un rollback automatique redémarre la version précédente et
   * efface l'état qui expliquait l'échec. Le diagnostic doit donc être pris
   * avant que la sonde ne rende la main, pas au moment où quelqu'un le lira.
   */
  private async unhealthy(
    ctx: DriverContext,
    partial: Omit<HealthResult, 'healthy' | 'diagnostics'>,
  ): Promise<HealthResult> {
    return {
      healthy: false,
      diagnostics: await this.diagnose(ctx),
      ...partial,
    };
  }

  /** `docker compose ps` + les 200 dernières lignes de logs de chaque service. */
  private async diagnose(ctx: DriverContext): Promise<string | null> {
    const sections: string[] = [];

    const ps = await exec(ctx.sshSession, this.compose(ctx, 'ps -a'), {
      timeout: SHORT_TIMEOUT_MS,
    });
    if (ps.stdout.trim().length > 0) {
      sections.push(`$ docker compose ps -a\n${ps.stdout.trim()}`);
    }

    for (const service of ctx.spec.services) {
      const logs = await exec(
        ctx.sshSession,
        this.compose(ctx, `logs --no-color --tail ${DIAGNOSTIC_LINES} ${shellQuote(service.name)}`),
        { timeout: DIAGNOSTIC_TIMEOUT_MS },
      );
      const output = `${logs.stdout}\n${logs.stderr}`.trim();
      sections.push(
        `$ docker compose logs --tail ${DIAGNOSTIC_LINES} ${service.name}\n` +
          (output.length > 0 ? output : '(aucune sortie)'),
      );
    }

    return sections.length > 0 ? sections.join('\n\n') : null;
  }

  // ─── rollback ───────────────────────────────────────────────────────────────

  async rollback(ctx: DriverContext, onLog: LogSink): Promise<void> {
    const previous = ctx.previousDeployment;
    if (!previous) {
      throw new DriverError(
        'rollback exige un `previousDeployment` dans le contexte',
        this.runtime,
        'rollback',
      );
    }

    const target = this.releasePath(ctx, previous.version);
    const exists = await exec(ctx.sshSession, `test -f ${shellQuote(`${target}/compose.yml`)}`, {
      timeout: SHORT_TIMEOUT_MS,
    });
    if (exists.code !== 0) {
      throw new DriverError(
        `La version précédente ${previous.version} n'est plus sur la cible (${target})`,
        this.runtime,
        'rollback',
      );
    }

    onLog(`→ retour à la version ${previous.version}`);
    await this.stream(
      ctx,
      this.compose(ctx, 'up -d --remove-orphans --wait --wait-timeout 300', previous.version),
      onLog,
      'rollback',
      UP_TIMEOUT_MS,
    );

    await this.run(
      ctx,
      `ln -sfn ${shellQuote(target)} ${shellQuote(`${this.appPath(ctx)}/current`)}`,
      onLog,
      'link',
    );
    onLog(`✓ revenu à la version ${previous.version}`);
  }

  // ─── destroy ────────────────────────────────────────────────────────────────

  /** Rétention des versions : voir `DeploymentDriver.pruneReleases`. */
  async pruneReleases(ctx: DriverContext, onLog: LogSink, keep?: number): Promise<string[]> {
    return pruneReleases(ctx, this.appPath(ctx), onLog, keep);
  }

  async destroy(ctx: DriverContext, onLog: LogSink): Promise<void> {
    const appPath = this.appPath(ctx);
    const key = { targetId: ctx.target.id, applicationId: ctx.applicationId };

    // Lu avant toute destruction : après `release()`, plus personne ne sait
    // quel port refermer.
    const port = ctx.portAllocator ? await ctx.portAllocator.current(key) : null;

    onLog('→ docker compose down -v');
    // `|| true` : détruire une app déjà absente doit rester idempotent.
    await this.stream(
      ctx,
      `cd ${shellQuote(appPath)}/current 2>/dev/null && docker compose down -v --remove-orphans || true`,
      onLog,
      'destroy',
      UP_TIMEOUT_MS,
      false,
    );

    onLog(`→ suppression de ${appPath}`);
    await this.run(ctx, `rm -rf ${shellQuote(appPath)}`, onLog, 'destroy');

    if (port !== null) {
      onLog(`→ fermeture du port ${port} sur le pare-feu`);
      await this.closeFirewall(ctx, port, onLog);
    }

    if (ctx.portAllocator) {
      await ctx.portAllocator.release(key);
      onLog('→ allocation de port libérée');
    }

    onLog('✓ déploiement détruit');
  }

  // ─── logs ───────────────────────────────────────────────────────────────────

  async logs(ctx: DriverContext, onLine: LogSink): Promise<void> {
    await execStream(
      ctx.sshSession,
      this.compose(ctx, 'logs -f --no-color --tail 200'),
      (line) => onLine(line),
      // Un suivi de logs n'a pas de fin naturelle : c'est l'appelant qui coupe
      // la session quand il a fini.
      { timeout: null, logOutput: false },
    );
  }

  // ─── supervision ────────────────────────────────────────────────────────────

  /**
   * `docker compose ps --format json` sort tantôt un tableau, tantôt un objet
   * par ligne selon la version de Compose. On accepte les deux.
   */
  async status(ctx: DriverContext): Promise<AppStatus> {
    const result = await exec(ctx.sshSession, this.compose(ctx, 'ps -a --format json'), {
      timeout: SHORT_TIMEOUT_MS,
      logOutput: false,
    });

    const checkedAt = new Date().toISOString();
    if (result.code !== 0) return { services: [], checkedAt };

    return { services: parseComposePs(result.stdout), checkedAt };
  }

  async restart(ctx: DriverContext, onLog: LogSink): Promise<void> {
    onLog('docker compose restart');
    await this.stream(ctx, this.compose(ctx, 'restart'), onLog, 'restart', UP_TIMEOUT_MS);
    onLog('services redémarrés');
  }

  // ─── charges de la cible ────────────────────────────────────────────────────

  /**
   * Tout ce qui tourne sur la machine, panel compris.
   *
   * Deux commandes en une seule session : `docker ps` pour la formulation
   * humaine de l'état (« Up 2 hours »), que seul lui produit, et `docker inspect`
   * pour le reste. Les labels ne sont lus que dans `inspect` : le `{{.Labels}}`
   * de `docker ps` les aplatit en une liste séparée par des virgules, or une
   * valeur de label peut en contenir — `maintainer=NGINX Docker Maintainers`
   * suffit à casser le découpage.
   */
  async listWorkloads(ctx: TargetContext): Promise<Workload[]> {
    const script = [
      "docker ps -a --no-trunc --format '{{.ID}} {{.Status}}'",
      `echo "${SENTINEL}"`,
      // `docker inspect` sans argument est une erreur : le cas « aucun
      // conteneur » doit produire un tableau vide, pas un code de retour.
      'ids=$(docker ps -aq --no-trunc)',
      'if [ -n "$ids" ]; then docker inspect $ids; else echo "[]"; fi',
    ].join('\n');

    const result = await exec(ctx.sshSession, script, {
      timeout: SHORT_TIMEOUT_MS,
      // La sortie porte les variables d'environnement des conteneurs : elle
      // n'entre jamais dans un journal.
      logOutput: false,
    });

    if (result.code !== 0) {
      throw new DriverError(
        `Inventaire impossible : ${firstLine(result.stderr) ?? `code ${result.code}`}`,
        this.runtime,
        'workload.list',
      );
    }

    const marker = result.stdout.indexOf(SENTINEL);
    const statuses = parsePsStatuses(marker < 0 ? '' : result.stdout.slice(0, marker));
    const inspected = parseInspect(marker < 0 ? result.stdout : result.stdout.slice(marker + SENTINEL.length));

    return inspected.map((raw) => toWorkload(raw, statuses));
  }

  /**
   * Supprime un conteneur.
   *
   * `docker rm -f` et rien de plus : pas de `-v`. Les volumes anonymes d'un
   * conteneur étranger au panel peuvent porter des données que personne ici
   * n'est en mesure d'évaluer — les effacer serait un choix pris à la place de
   * leur propriétaire.
   */
  async removeWorkload(ctx: TargetContext, ref: WorkloadRef, onLog: LogSink): Promise<void> {
    const { raw, workload } = await this.findWorkload(ctx, ref, 'workload.remove');

    // Second verrou, après celui de la route : un driver ne fait pas confiance
    // à son appelant pour une opération irréversible.
    if (workload.managed) {
      throw new DriverError(managedWorkloadRefusal(workload), this.runtime, 'workload.remove');
    }

    onLog(`→ suppression du conteneur « ${workload.name} » (${shortId(raw.Id ?? ref.id)})`);
    await this.stream(
      ctx,
      `docker rm -f ${shellQuote(ref.id)}`,
      onLog,
      'workload.remove',
      REMOVE_TIMEOUT_MS,
    );
    onLog('✓ conteneur supprimé — ses volumes nommés, eux, sont conservés');
  }

  /**
   * Mettre à jour, en Docker, veut dire exactement ceci :
   *
   *   1. `docker pull` de l'image que le conteneur exécute, à son tag actuel ;
   *   2. relecture de sa configuration effective (`docker inspect`) ;
   *   3. recréation d'un conteneur neuf, même nom, même configuration, sur
   *      l'image fraîchement tirée.
   *
   * « Même configuration » se lit par différence avec l'image que le conteneur
   * exécutait : seules les valeurs que quelqu'un a explicitement posées à la
   * création sont reportées. Recopier l'environnement complet reviendrait à
   * figer les défauts de l'ancienne image dans le conteneur neuf, et donc à
   * annuler une partie de la mise à jour qu'on vient de tirer.
   *
   * L'ancien conteneur est renommé et arrêté plutôt que supprimé : si la
   * création échoue, il est remis en place sous son nom et redémarré. Une mise
   * à jour ratée ne doit pas laisser la machine avec un service en moins.
   */
  async updateWorkload(ctx: TargetContext, ref: WorkloadRef, onLog: LogSink): Promise<void> {
    const { raw, workload } = await this.findWorkload(ctx, ref, 'workload.update');

    if (workload.managed) {
      throw new DriverError(
        `« ${workload.name} » est déployée par le panel : sa mise à jour est un ` +
          'redéploiement, pas une recréation à la main. Passez par un nouveau déploiement.',
        this.runtime,
        'workload.update',
      );
    }

    const image = raw.Config?.Image;
    if (!image) {
      throw new DriverError(
        `Impossible de lire l'image de « ${workload.name} »`,
        this.runtime,
        'workload.update',
      );
    }

    // Défauts de l'image **que ce conteneur exécute**, désignée par son digest :
    // le tag, lui, va changer sous nos pieds au `pull` suivant.
    const previousImageId = raw.Image ?? image;
    const defaults = await this.imageDefaults(ctx, previousImageId);

    const unsupported = unreproducibleOptions(raw, defaults);
    if (unsupported.length > 0) {
      throw new DriverError(
        `« ${workload.name} » utilise des options que le panel ne sait pas reproduire ` +
          `(${unsupported.join(', ')}). La recréer les perdrait : mettez-la à jour à la main.`,
        this.runtime,
        'workload.update',
      );
    }

    const name = workload.name;
    onLog(`→ docker pull ${image}`);
    await this.stream(
      ctx,
      `docker pull ${shellQuote(image)}`,
      onLog,
      'workload.update',
      PULL_TIMEOUT_MS,
    );

    const pulled = await exec(
      ctx.sshSession,
      `docker image inspect --format '{{.Id}}' ${shellQuote(image)}`,
      { timeout: SHORT_TIMEOUT_MS },
    );
    const newImageId = firstLine(pulled.stdout);
    onLog(
      newImageId && newImageId === previousImageId
        ? "l'image était déjà à jour — la charge est tout de même recréée"
        : `image mise à jour : ${shortId(previousImageId)} → ${shortId(newImageId ?? '?')}`,
    );

    const wasRunning = workload.state === 'running' || workload.state === 'restarting';
    const backup = `${name}-tp-prev-${Date.now()}`;
    const createArgs = renderCreateArgs(raw, defaults, name);
    const extraNetworks = extraNetworkNames(raw);

    onLog(`→ mise de côté de l'ancien conteneur sous « ${backup} »`);
    await this.run(ctx, `docker rename ${shellQuote(ref.id)} ${shellQuote(backup)}`, onLog, 'workload.update');
    await this.run(ctx, `docker stop -t 20 ${shellQuote(backup)}`, onLog, 'workload.update');

    try {
      onLog(`→ docker create --name ${name}`);
      await this.stream(
        ctx,
        `docker ${createArgs.map(shellQuote).join(' ')}`,
        onLog,
        'workload.update',
        REMOVE_TIMEOUT_MS,
      );

      for (const network of extraNetworks) {
        onLog(`→ rattachement au réseau ${network}`);
        await this.run(
          ctx,
          `docker network connect ${shellQuote(network)} ${shellQuote(name)}`,
          onLog,
          'workload.update',
        );
      }

      if (wasRunning) {
        await this.run(ctx, `docker start ${shellQuote(name)}`, onLog, 'workload.update');
        onLog('✓ conteneur recréé et redémarré');
      } else {
        // Une charge arrêtée le reste : la mise à jour ne décide pas à la place
        // de celui qui l'avait arrêtée.
        onLog('✓ conteneur recréé, laissé à l’arrêt comme il l’était');
      }
    } catch (error) {
      onLog('✗ recréation impossible — remise en place de l’ancien conteneur');
      // Le nettoyage ne doit pas masquer l'échec d'origine : il est tenté au
      // mieux, et c'est l'erreur initiale qui remonte.
      await this.tryQuietly(ctx, `docker rm -f ${shellQuote(name)}`);
      await this.tryQuietly(ctx, `docker rename ${shellQuote(backup)} ${shellQuote(name)}`);
      if (wasRunning) await this.tryQuietly(ctx, `docker start ${shellQuote(name)}`);
      throw error;
    }

    await this.tryQuietly(ctx, `docker rm -f ${shellQuote(backup)}`);
    onLog('✓ ancien conteneur retiré');
  }

  /** Relit une charge sur la machine, et refuse d'agir à l'aveugle. */
  private async findWorkload(
    ctx: TargetContext,
    ref: WorkloadRef,
    step: string,
  ): Promise<{ raw: DockerInspect; workload: Workload }> {
    const result = await exec(ctx.sshSession, `docker inspect ${shellQuote(ref.id)}`, {
      timeout: SHORT_TIMEOUT_MS,
      logOutput: false,
    });

    const [raw] = result.code === 0 ? parseInspect(result.stdout) : [];
    if (!raw) {
      throw new DriverError(
        `Aucun conteneur « ${ref.id} » sur cette cible`,
        this.runtime,
        step,
      );
    }

    return { raw, workload: toWorkload(raw, new Map()) };
  }

  /** Configuration par défaut d'une image, pour distinguer l'explicite du hérité. */
  private async imageDefaults(ctx: TargetContext, imageId: string): Promise<ImageDefaults> {
    const result = await exec(ctx.sshSession, `docker image inspect ${shellQuote(imageId)}`, {
      timeout: SHORT_TIMEOUT_MS,
      logOutput: false,
    });
    return result.code === 0 ? parseImageDefaults(result.stdout) : EMPTY_IMAGE_DEFAULTS;
  }

  /** Rattrapage d'urgence : on tente, on n'échoue pas dessus. */
  private async tryQuietly(ctx: TargetContext, command: string): Promise<void> {
    try {
      await exec(ctx.sshSession, command, { timeout: SHORT_TIMEOUT_MS, logOutput: false });
    } catch {
      // Rien à sauver : l'erreur qui compte est celle qui nous a menés ici.
    }
  }

  // ─── exécution ──────────────────────────────────────────────────────────────

  private async run(
    ctx: TargetContext,
    command: string,
    onLog: LogSink,
    step: string,
  ): Promise<void> {
    const result = await exec(ctx.sshSession, command, { timeout: SHORT_TIMEOUT_MS });
    if (result.code !== 0) {
      const detail = firstLine(result.stderr) ?? `code ${result.code}`;
      onLog(`✗ ${detail}`);
      throw new DriverError(`Échec de « ${command} » : ${detail}`, this.runtime, step);
    }
  }

  private async stream(
    ctx: TargetContext,
    command: string,
    onLog: LogSink,
    step: string,
    timeout: number,
    failOnError = true,
  ): Promise<void> {
    const result = await execStream(ctx.sshSession, command, (line) => onLog(line), {
      timeout,
      logOutput: false,
    });

    if (result.timedOut) {
      throw new DriverError(`« ${step} » a dépassé son délai`, this.runtime, step);
    }
    if (failOnError && result.code !== 0) {
      throw new DriverError(
        `Échec de « ${step} » (code ${result.code}) : ${firstLine(result.stderr) ?? 'sans détail'}`,
        this.runtime,
        step,
      );
    }
  }
}

// ─── utilitaires ──────────────────────────────────────────────────────────────

/** Échappement POSIX en quotes simples. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function firstLine(value: string): string | null {
  const line = value.split('\n').find((candidate) => candidate.trim().length > 0);
  return line?.trim() ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


/** Quatrième colonne de `df -Pk`, convertie en Mio. */
function parseAvailableMi(output: string): number | null {
  const lines = output.trim().split('\n');
  const row = lines[lines.length - 1];
  if (!row || lines.length < 2) return null;

  const columns = row.trim().split(/\s+/);
  const availableKb = Number.parseInt(columns[3] ?? '', 10);
  return Number.isNaN(availableKb) ? null : Math.floor(availableKb / 1024);
}

/** `docker compose ps --format json` : un objet par ligne, ou un tableau. */
function countRunning(output: string): number {
  const trimmed = output.trim();
  if (trimmed.length === 0) return 0;

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed.length;
  } catch {
    // Format « JSON Lines » selon la version de Compose.
  }

  return trimmed.split('\n').filter((line) => line.trim().startsWith('{')).length;
}

/** États remontés par Compose, ramenés au vocabulaire neutre de la supervision. */
function toServiceState(raw: string): ServiceState {
  const value = raw.toLowerCase();
  if (value.includes('running')) return 'running';
  if (value.includes('restarting')) return 'restarting';
  if (value.includes('exited') || value.includes('dead')) return 'exited';
  if (value.includes('paused')) return 'paused';
  if (value.includes('created')) return 'created';
  return 'unknown';
}

function toHealth(raw: string): ServiceStatus['health'] {
  const value = raw.toLowerCase();
  if (value.includes('unhealthy')) return 'unhealthy';
  if (value.includes('starting')) return 'starting';
  if (value.includes('healthy')) return 'healthy';
  return 'none';
}

type ComposePsRow = {
  Service?: unknown;
  Name?: unknown;
  State?: unknown;
  Status?: unknown;
  Health?: unknown;
  Image?: unknown;
  Publishers?: unknown;
};

/** Accepte le tableau JSON comme le « JSON Lines », selon la version de Compose. */
function parseComposePs(output: string): ServiceStatus[] {
  const trimmed = output.trim();
  if (trimmed.length === 0) return [];

  const rows: ComposePsRow[] = [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) rows.push(...(parsed as ComposePsRow[]));
    else if (parsed && typeof parsed === 'object') rows.push(parsed as ComposePsRow);
  } catch {
    for (const line of trimmed.split('\n')) {
      const candidate = line.trim();
      if (!candidate.startsWith('{')) continue;
      try {
        rows.push(JSON.parse(candidate) as ComposePsRow);
      } catch {
        // Ligne tronquée : on la saute plutôt que d'échouer sur tout le lot.
      }
    }
  }

  return rows.map((row) => {
    const status = typeof row.Status === 'string' ? row.Status : '';
    const ports =
      typeof row.Publishers === 'string'
        ? [row.Publishers]
        : Array.isArray(row.Publishers)
          ? row.Publishers.map((p) => {
              const entry = p as { PublishedPort?: number; TargetPort?: number };
              return entry.PublishedPort && entry.TargetPort
                ? `${entry.PublishedPort}→${entry.TargetPort}`
                : '';
            }).filter((value) => value.length > 0)
          : [];

    return {
      name: typeof row.Service === 'string' ? row.Service : String(row.Name ?? 'inconnu'),
      state: toServiceState(typeof row.State === 'string' ? row.State : status),
      health: toHealth(typeof row.Health === 'string' && row.Health ? row.Health : status),
      since: status.length > 0 ? status : null,
      image: typeof row.Image === 'string' ? row.Image : null,
      ports,
    };
  });
}

/** Type guard pour la spec, utile aux appelants. */
export function hasBuildableService(spec: AppSpec): boolean {
  return spec.services.some((service) => service.source.type === 'dockerfile');
}

// ─── charges de la cible : lecture de Docker ──────────────────────────────────

/**
 * Labels que le rendu Compose pose sur chaque service (`docker/render.ts`).
 * Redéclarés ici plutôt qu'importés : ce sont les *empreintes* que le driver
 * cherche sur la machine, pas les valeurs qu'il écrit.
 */
const MANAGED_LABEL = 'pupitre.managed-by';
const MANAGED_VALUE = 'pupitre';

/**
 * L'empreinte d'avant le renommage, toujours lue.
 *
 * Un conteneur déployé hier porte `tp.managed-by: bootstrap-tp-v2` et tourne
 * encore. Ne reconnaître que la nouvelle empreinte le ferait passer pour une
 * charge étrangère : l'écran des charges cesserait de dire « gérée par le
 * panel », et proposerait de la supprimer à la main. Un renommage ne doit pas
 * faire perdre au panel la trace de ce qu'il a lui-même posé.
 *
 * Ces deux constantes disparaîtront quand plus aucune cible ne portera de
 * conteneur d'avant le renommage — c'est-à-dire jamais de façon vérifiable, et
 * c'est pourquoi elles restent.
 */
const LEGACY_MANAGED_LABEL = 'tp.managed-by';
const LEGACY_MANAGED_VALUE = 'bootstrap-tp-v2';

const APP_LABEL = 'pupitre.app';
const LEGACY_APP_LABEL = 'tp.app';
const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';

type DockerPortBinding = { HostIp?: string; HostPort?: string };

type DockerInspect = {
  Id?: string;
  Name?: string;
  Created?: string;
  Image?: string;
  State?: { Status?: string; Health?: { Status?: string } };
  Config?: {
    Image?: string;
    Labels?: Record<string, string> | null;
    Env?: string[] | null;
    Cmd?: string[] | null;
    Entrypoint?: string[] | null;
    User?: string;
    WorkingDir?: string;
    Tty?: boolean;
    OpenStdin?: boolean;
  };
  HostConfig?: {
    RestartPolicy?: { Name?: string; MaximumRetryCount?: number };
    PortBindings?: Record<string, DockerPortBinding[] | null> | null;
    Binds?: string[] | null;
    NetworkMode?: string;
    Privileged?: boolean;
    CapAdd?: string[] | null;
    CapDrop?: string[] | null;
    Devices?: unknown[] | null;
    ExtraHosts?: string[] | null;
    Ulimits?: unknown[] | null;
    GroupAdd?: string[] | null;
    Sysctls?: Record<string, string> | null;
    Tmpfs?: Record<string, string> | null;
  };
  NetworkSettings?: {
    Ports?: Record<string, DockerPortBinding[] | null> | null;
    Networks?: Record<string, unknown> | null;
  };
  Mounts?: Array<{ Type?: string; Name?: string; Destination?: string; RW?: boolean }>;
};

/** Ce que l'image apporte d'elle-même, et qu'il ne faut donc pas recopier. */
type ImageDefaults = {
  env: string[];
  labels: Record<string, string>;
  cmd: string[] | null;
  entrypoint: string[] | null;
  workingDir: string | null;
  user: string | null;
};

const EMPTY_IMAGE_DEFAULTS: ImageDefaults = {
  env: [],
  labels: {},
  cmd: null,
  entrypoint: null,
  workingDir: null,
  user: null,
};

function shortId(value: string): string {
  return value.replace(/^sha256:/, '').slice(0, 12);
}

function sameList(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** `docker ps -a --no-trunc --format '{{.ID}} {{.Status}}'` → id → « Up 2 hours ». */
function parsePsStatuses(output: string): Map<string, string> {
  const statuses = new Map<string, string>();
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const space = trimmed.indexOf(' ');
    if (space <= 0) continue;
    statuses.set(trimmed.slice(0, space), trimmed.slice(space + 1).trim());
  }
  return statuses;
}

/** `docker inspect` : un tableau JSON, précédé du bruit éventuel de la session. */
function parseInspect(output: string): DockerInspect[] {
  const start = output.indexOf('[');
  if (start < 0) return [];
  try {
    const parsed: unknown = JSON.parse(output.slice(start));
    return Array.isArray(parsed) ? (parsed as DockerInspect[]) : [];
  } catch {
    return [];
  }
}

function parseImageDefaults(output: string): ImageDefaults {
  const [image] = parseInspect(output);
  const config = image?.Config;
  if (!config) return EMPTY_IMAGE_DEFAULTS;

  return {
    env: config.Env ?? [],
    labels: config.Labels ?? {},
    cmd: config.Cmd ?? null,
    entrypoint: config.Entrypoint ?? null,
    workingDir: config.WorkingDir ?? null,
    user: config.User ?? null,
  };
}

function publishedPorts(raw: DockerInspect): string[] {
  const ports = raw.NetworkSettings?.Ports ?? {};
  const out: string[] = [];

  for (const [portProto, bindings] of Object.entries(ports)) {
    for (const binding of bindings ?? []) {
      if (!binding.HostPort) continue;
      const host =
        binding.HostIp && binding.HostIp !== '0.0.0.0' && binding.HostIp !== '::'
          ? `${binding.HostIp}:${binding.HostPort}`
          : binding.HostPort;
      const entry = `${host}→${portProto}`;
      if (!out.includes(entry)) out.push(entry);
    }
  }

  return out;
}

/**
 * Conteneur inspecté → charge neutre.
 *
 * `managed` a trois sources et c'est voulu : l'empreinte courante que le panel
 * pose lui-même, celle d'avant le renommage en Pupitre, et le préfixe de projet
 * `app-` qui rattrape les conteneurs posés par une version antérieure du rendu.
 * Un faux négatif ici autoriserait la suppression d'une application vivante.
 */
function toWorkload(raw: DockerInspect, statuses: Map<string, string>): Workload {
  const id = raw.Id ?? '';
  const labels = raw.Config?.Labels ?? {};
  const project = labels[COMPOSE_PROJECT_LABEL] ?? null;
  const fromProject = project !== null && project.startsWith(PROJECT_PREFIX);
  const rawState = raw.State?.Status ?? '';

  return {
    runtime: 'docker',
    id,
    name: (raw.Name ?? '').replace(/^\//, '') || shortId(id),
    // Une **clé**, pas un mot : « conteneur » ici figeait la langue du panel
    // dans une donnée produite par le driver. Le libellé se choisit à la
    // lecture, dans l'écran qui l'affiche.
    kind: 'container',
    scope: project,
    image: raw.Config?.Image ?? null,
    state: toServiceState(rawState),
    health: toHealth(raw.State?.Health?.Status ?? ''),
    createdAt: raw.Created ?? null,
    since: statuses.get(id) ?? (rawState.length > 0 ? rawState : null),
    ports: publishedPorts(raw),
    managed:
      labels[MANAGED_LABEL] === MANAGED_VALUE ||
      labels[LEGACY_MANAGED_LABEL] === LEGACY_MANAGED_VALUE ||
      fromProject,
    managedApp:
      labels[APP_LABEL] ??
      labels[LEGACY_APP_LABEL] ??
      (fromProject && project ? project.slice(PROJECT_PREFIX.length) : null),
  };
}

/**
 * Options de création que la ligne de commande ne sait pas reproduire
 * fidèlement. Les détecter et refuser vaut mieux que recréer une charge
 * silencieusement diminuée.
 */
function unreproducibleOptions(raw: DockerInspect, defaults: ImageDefaults): string[] {
  const host = raw.HostConfig ?? {};
  const out: string[] = [];

  if (host.Privileged === true) out.push('--privileged');
  if ((host.CapAdd ?? []).length > 0) out.push('--cap-add');
  if ((host.CapDrop ?? []).length > 0) out.push('--cap-drop');
  if ((host.Devices ?? []).length > 0) out.push('--device');
  if ((host.ExtraHosts ?? []).length > 0) out.push('--add-host');
  if ((host.Ulimits ?? []).length > 0) out.push('--ulimit');
  if ((host.GroupAdd ?? []).length > 0) out.push('--group-add');
  if (Object.keys(host.Sysctls ?? {}).length > 0) out.push('--sysctl');
  if (Object.keys(host.Tmpfs ?? {}).length > 0) out.push('--tmpfs');

  const mode = host.NetworkMode ?? '';
  // Un conteneur qui partage la pile réseau d'un autre dépend d'un identifiant
  // qui aura peut-être disparu : on ne le recrée pas au jugé.
  if (mode.startsWith('container:')) out.push('--network container:…');

  const entrypoint = raw.Config?.Entrypoint ?? null;
  // `--entrypoint` ne prend qu'un seul mot : une forme exec à plusieurs
  // éléments n'a pas d'équivalent en ligne de commande.
  if (entrypoint && entrypoint.length > 1 && !sameList(entrypoint, defaults.entrypoint)) {
    out.push('--entrypoint (forme exec)');
  }

  return out;
}

/** Montages à reporter : les binds déclarés, plus les volumes nommés ou anonymes. */
function volumeArgs(raw: DockerInspect): string[] {
  const out = [...(raw.HostConfig?.Binds ?? [])];

  for (const mount of raw.Mounts ?? []) {
    if (mount.Type !== 'volume' || !mount.Name || !mount.Destination) continue;
    const destination = mount.Destination;
    const covered = out.some((bind) => bind.split(':')[1] === destination);
    if (covered) continue;
    // Un volume anonyme porte des données que la recréation perdrait si on le
    // laissait de côté : on le rattache explicitement par son nom.
    out.push(`${mount.Name}:${destination}${mount.RW === false ? ':ro' : ''}`);
  }

  return out;
}

/** Réseau principal du conteneur, tel que `docker create --network` l'attend. */
function primaryNetwork(raw: DockerInspect): string {
  const mode = raw.HostConfig?.NetworkMode ?? 'default';
  return mode === 'default' ? 'bridge' : mode;
}

function extraNetworkNames(raw: DockerInspect): string[] {
  const primary = primaryNetwork(raw);
  return Object.keys(raw.NetworkSettings?.Networks ?? {}).filter((name) => name !== primary);
}

/**
 * Arguments d'un `docker create` reproduisant la configuration **explicite**
 * du conteneur : tout ce qui égale la valeur par défaut de l'image en est
 * absent, pour que l'image fraîchement tirée puisse imposer la sienne.
 */
function renderCreateArgs(raw: DockerInspect, defaults: ImageDefaults, name: string): string[] {
  const config = raw.Config ?? {};
  const host = raw.HostConfig ?? {};
  const args = ['create', '--name', name];

  const restart = host.RestartPolicy?.Name ?? '';
  if (restart.length > 0 && restart !== 'no') {
    const retries = host.RestartPolicy?.MaximumRetryCount ?? 0;
    args.push('--restart', restart === 'on-failure' && retries > 0 ? `on-failure:${retries}` : restart);
  }

  const imageEnv = new Set(defaults.env);
  for (const entry of config.Env ?? []) {
    if (!imageEnv.has(entry)) args.push('--env', entry);
  }

  for (const [key, value] of Object.entries(config.Labels ?? {})) {
    if (defaults.labels[key] === value) continue;
    args.push('--label', `${key}=${value}`);
  }

  for (const [portProto, bindings] of Object.entries(host.PortBindings ?? {})) {
    for (const binding of bindings ?? []) {
      const ip = binding.HostIp && binding.HostIp.length > 0 ? `${binding.HostIp}:` : '';
      const hostPort = binding.HostPort ?? '';
      args.push('--publish', hostPort.length > 0 ? `${ip}${hostPort}:${portProto}` : `${ip}${portProto}`);
    }
  }

  for (const volume of volumeArgs(raw)) args.push('--volume', volume);

  const network = primaryNetwork(raw);
  if (network !== 'bridge') args.push('--network', network);

  if (config.User && config.User !== defaults.user) args.push('--user', config.User);
  if (config.WorkingDir && config.WorkingDir !== defaults.workingDir) {
    args.push('--workdir', config.WorkingDir);
  }
  if (config.Tty === true) args.push('--tty');
  if (config.OpenStdin === true) args.push('--interactive');

  const entrypoint = config.Entrypoint ?? null;
  if (entrypoint && entrypoint.length === 1 && !sameList(entrypoint, defaults.entrypoint)) {
    args.push('--entrypoint', entrypoint[0] as string);
  }

  args.push(config.Image ?? '');

  // La commande n'est reportée que si quelqu'un l'a posée : sinon c'est le
  // `CMD` de la nouvelle image qui doit s'appliquer.
  const cmd = config.Cmd ?? null;
  if (cmd && !sameList(cmd, defaults.cmd)) args.push(...cmd);

  return args;
}
