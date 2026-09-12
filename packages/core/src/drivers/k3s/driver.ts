import { exec, execStream, upload } from '../../ssh/client.js';
import { storedSecretNames, topologicalOrder, type Service } from '../../spec/index.js';
import { backoffMs } from '../backoff.js';
import type { AppStatus, ServiceState, ServiceStatus } from '../../supervision.js';
import { pruneReleases } from '../retention.js';
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
import {
  LEGACY_MANAGED_BY,
  MANAGED_BY,
  MANAGED_SELECTOR,
  MANIFEST_DIR,
  builtImageTag,
  entrypointService,
  namespaceFilePath,
  namespaceName,
  renderFiles,
} from './render.js';

/**
 * Driver K3s.
 *
 * Pendant exact du `DockerComposeDriver` : mêmes responsabilités, même contrat,
 * mêmes AppSpec en entrée. Il n'importe rien de `packages/db`, rien de
 * `apps/web`, rien de Redis — tout arrive par `DriverContext`.
 *
 * Deux divergences assumées, et elles vivent **ici**, pas dans le pipeline :
 *
 * - `allocatePort()` retourne `null` : en Kubernetes l'exposition passe par
 *   l'Ingress, pas par un port hôte. Le pipeline marque l'étape « skipped » tout
 *   seul, parce que c'est le driver qui a répondu `null`.
 * - le build ne pousse rien vers un registry : l'image est construite sur le
 *   node puis importée dans le containerd de K3s.
 *
 * Accès au cluster : `kubectl` **sur la cible**, via SSH. Le kubeconfig ne
 * quitte jamais la machine — pas de client Kubernetes embarqué dans le panel,
 * exactement comme le driver Docker ne parle jamais au daemon à distance.
 */

const BUILD_TIMEOUT_MS = 20 * 60_000;
const APPLY_TIMEOUT_MS = 10 * 60_000;
const ROLLOUT_TIMEOUT = '5m';
const SHORT_TIMEOUT_MS = 30_000;
/** Lignes de logs remontées par pod quand le healthcheck échoue. */
const DIAGNOSTIC_LINES = 200;
/** Nombre de pods décrits en détail : au-delà, le diagnostic devient illisible. */
const DIAGNOSTIC_PODS = 5;
const DIAGNOSTIC_TIMEOUT_MS = 60_000;

/**
 * K3s écrit son kubeconfig dans `/etc/rancher/k3s/k3s.yaml` et ne l'installe pas
 * dans `$HOME/.kube`. On respecte un `KUBECONFIG` déjà positionné — une cible
 * peut viser un cluster distant — et on retombe sur le chemin K3s sinon.
 */
const KUBECONFIG_SETUP =
  'if [ -z "${KUBECONFIG:-}" ] && [ -r /etc/rancher/k3s/k3s.yaml ]; ' +
  'then KUBECONFIG=/etc/rancher/k3s/k3s.yaml; export KUBECONFIG; fi';

export class K3sDriver implements DeploymentDriver {
  readonly runtime = 'k3s' as const;

  /** Le namespace sous lequel l'application est regroupée sur la cible. */
  workspaceName(appSlug: string): string {
    return namespaceName(appSlug);
  }

  /** Le décalque exact de `destroy()`, à passer à la main sur la machine. */
  manualCleanup(appSlug: string, rootPath: string): string[] {
    return [
      `kubectl delete namespace ${namespaceName(appSlug)} --ignore-not-found`,
      `rm -rf ${rootPath}/apps/${appSlug}`,
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

  /** `/opt/bootstrap/apps/{slug}/{version}/k8s` */
  private manifestPath(ctx: DriverContext, version = ctx.deployment.version): string {
    return `${this.releasePath(ctx, version)}/${MANIFEST_DIR}`;
  }

  private namespace(ctx: DriverContext): string {
    return namespaceName(ctx.appSlug);
  }

  /** Script shell précédé de la résolution du kubeconfig. */
  private script(lines: string[]): string {
    return [KUBECONFIG_SETUP, ...lines].join('\n');
  }

  private kubectl(args: string): string {
    return this.script([`kubectl ${args}`]);
  }

  /** `kubectl` dans le namespace de l'application. */
  private kube(ctx: DriverContext, args: string): string {
    return this.kubectl(`-n ${this.namespace(ctx)} ${args}`);
  }

  // ─── preflight ──────────────────────────────────────────────────────────────

  async preflight(ctx: DriverContext): Promise<PreflightResult> {
    const checks: PreflightResult['checks'] = [];

    const nodes = await exec(ctx.sshSession, this.kubectl('get nodes -o json'), {
      timeout: SHORT_TIMEOUT_MS,
    });
    const cluster = nodes.code === 0 ? parseNodes(nodes.stdout) : null;
    const runtimeVersion = cluster?.version ?? null;
    checks.push({
      key: 'cluster',
      label: 'Cluster Kubernetes',
      ok: cluster !== null && cluster.readyNodes > 0,
      detail:
        cluster === null
          ? (firstLine(nodes.stderr) ?? `kubectl injoignable (code ${nodes.code})`)
          : `${cluster.readyNodes}/${cluster.nodes} node(s) prêt(s)${
              cluster.version ? ` — ${cluster.version}` : ''
            }`,
    });

    // Les droits se vérifient avant de rendre quoi que ce soit : un `apply` qui
    // échoue à mi-parcours laisse un namespace à moitié peuplé.
    const rights = await this.checkRights(ctx);
    checks.push(...rights);

    const ingress = await exec(
      ctx.sshSession,
      this.kubectl("get ingressclass -o jsonpath='{.items[*].metadata.name}'"),
      { timeout: SHORT_TIMEOUT_MS },
    );
    const classes = ingress.code === 0 ? ingress.stdout.trim() : '';
    checks.push({
      key: 'ingress_controller',
      label: "Contrôleur d'ingress",
      ok: classes.length > 0,
      detail:
        classes.length > 0
          ? `IngressClass : ${classes.split(/\s+/).join(', ')}`
          : "aucune IngressClass — une AppSpec avec `ingress` ne serait pas joignable",
    });

    const disk = await exec(
      ctx.sshSession,
      `df -Pk ${shellQuote(ctx.target.rootPath)} 2>/dev/null || df -Pk /`,
      { timeout: SHORT_TIMEOUT_MS },
    );
    const availableDiskMi = parseAvailableMi(disk.stdout);
    checks.push({
      key: 'disk',
      label: 'Espace disque',
      ok: availableDiskMi !== null && availableDiskMi >= 1024,
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

  /** `kubectl auth can-i` — la seule réponse qui fasse autorité sur les droits. */
  private async checkRights(ctx: DriverContext): Promise<PreflightResult['checks']> {
    const verbs: Array<{ key: string; label: string; args: string }> = [
      {
        key: 'can_create_namespace',
        label: 'Droit de créer un namespace',
        args: 'auth can-i create namespaces',
      },
      {
        key: 'can_create_deployment',
        label: 'Droit de créer un déploiement',
        args: `auth can-i create deployments -n ${this.namespace(ctx)}`,
      },
    ];

    const checks: PreflightResult['checks'] = [];
    for (const verb of verbs) {
      const result = await exec(ctx.sshSession, this.kubectl(verb.args), {
        timeout: SHORT_TIMEOUT_MS,
      });
      const allowed = firstLine(result.stdout) === 'yes';
      checks.push({
        key: verb.key,
        label: verb.label,
        ok: allowed,
        detail: allowed ? 'oui' : (firstLine(result.stdout) ?? firstLine(result.stderr) ?? 'non'),
      });
    }
    return checks;
  }

  /**
   * Garantit que la racine du driver est écrivable par le compte de déploiement.
   * Identique au driver Docker : `/opt` appartient à root sur une machine
   * standard, le premier passage a besoin d'une élévation.
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
    const identity = await exec(ctx.sshSession, 'id -u; id -g', { timeout: SHORT_TIMEOUT_MS });
    const [uid, gid] = identity.stdout
      .trim()
      .split('\n')
      .map((value) => value.trim());
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

    const confirmed = await exec(ctx.sshSession, `test -w ${shellQuote(appPath)}`, {
      timeout: SHORT_TIMEOUT_MS,
    });
    return confirmed.code === 0
      ? { ok: true, detail: `${appPath} (provisionné via sudo)` }
      : { ok: false, detail: `${appPath} reste non écrivable après élévation` };
  }

  // ─── allocatePort ───────────────────────────────────────────────────────────

  /**
   * Aucun port hôte : en Kubernetes, l'exposition est le rôle de l'Ingress.
   * Retourner `null` est la réponse du driver, pas une exception traitée
   * ailleurs — le pipeline marquera l'étape « skipped » de lui-même.
   */
  async allocatePort(): Promise<number | null> {
    return null;
  }

  // ─── render ─────────────────────────────────────────────────────────────────

  async render(ctx: DriverContext): Promise<RenderedArtifacts> {
    // Les racines seulement : un alias n'a pas de valeur propre à demander.
    const secretNames = storedSecretNames(ctx.spec);
    const secretValues = ctx.resolveSecrets ? await ctx.resolveSecrets(secretNames) : {};

    const files = renderFiles({ spec: ctx.spec, appSlug: ctx.appSlug, secretValues });

    return { projectName: this.namespace(ctx), files, publishedPort: null };
  }

  // ─── upload ─────────────────────────────────────────────────────────────────

  async upload(ctx: DriverContext, artifacts: RenderedArtifacts, onLog: LogSink): Promise<void> {
    const release = this.releasePath(ctx);
    onLog(`namespace ${artifacts.projectName}, release ${release}`);

    const workdir = await this.ensureWorkdir(ctx);
    if (!workdir.ok) {
      throw new DriverError(
        `Racine de déploiement inutilisable : ${workdir.detail ?? 'raison inconnue'}`,
        this.runtime,
        'upload',
      );
    }
    await this.run(ctx, `mkdir -p ${shellQuote(this.manifestPath(ctx))}`, onLog, 'upload');

    const files: RenderedFile[] = [...(ctx.additionalFiles ?? []), ...artifacts.files];
    for (const file of files) {
      await this.uploadFile(ctx, release, file, onLog);
    }

    await this.assertBuildContexts(ctx, release, onLog);
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
    // Le contenu n'est jamais journalisé : le manifest Secret porte des valeurs.
    onLog(`  déposé ${file.path} (${file.content.length} octets)`);
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

  // ─── build ──────────────────────────────────────────────────────────────────

  /**
   * Construit sur le node puis importe dans le containerd de K3s.
   *
   * Décision figée du projet : pas de registry. L'image n'a donc jamais à
   * transiter par le réseau — elle naît et vit sur la machine qui l'exécute.
   *
   * `null` quand aucun service ne se construit : l'étape est alors `skipped`.
   */
  async build(ctx: DriverContext, onLog: LogSink): Promise<string[] | null> {
    const buildable = ctx.spec.services.filter(
      (service) => service.source.type === 'dockerfile',
    );
    if (buildable.length === 0) return null;

    const hasDocker = await exec(ctx.sshSession, 'command -v docker >/dev/null 2>&1', {
      timeout: SHORT_TIMEOUT_MS,
    });
    if (hasDocker.code !== 0) {
      const names = buildable.map((service) => `« ${service.name} »`).join(', ');
      throw new DriverError(
        'Aucun `docker` sur le node : un node K3s fait tourner containerd, et ' +
          "`k3s ctr` ne sait qu'importer une image, pas la construire. " +
          `Service(s) concerné(s) : ${names}. ` +
          'Installez Docker sur la cible, ou fournissez une AppSpec dont ces services ' +
          'référencent des images déjà publiées (`source.type: "image"`).',
        this.runtime,
        'build',
      );
    }

    const release = this.releasePath(ctx);
    const tags: string[] = [];

    for (const service of buildable) {
      const source = service.source;
      if (source.type !== 'dockerfile') continue;
      const tag = builtImageTag(ctx.appSlug, service.name, ctx.spec.version);
      const context = `${release}/${source.context}`;

      onLog(`docker build ${tag} (${service.name})`);
      await this.stream(
        ctx,
        `cd ${shellQuote(context)} && docker build -f ${shellQuote(source.dockerfile)} -t ${shellQuote(tag)} .`,
        onLog,
        'build',
        BUILD_TIMEOUT_MS,
      );

      // `k3s ctr` parle au containerd du cluster, qui n'est pas celui de Docker :
      // sans cet import, le kubelet chercherait l'image sur docker.io.
      onLog(`k3s ctr images import ${tag}`);
      await this.stream(
        ctx,
        `docker save ${shellQuote(tag)} | k3s ctr images import -`,
        onLog,
        'image_import',
        BUILD_TIMEOUT_MS,
        true,
        true,
      );

      tags.push(tag);
    }

    return tags;
  }

  // ─── deploy ─────────────────────────────────────────────────────────────────

  async deploy(ctx: DriverContext, onLog: LogSink): Promise<DeployResult> {
    const release = this.releasePath(ctx);
    const manifests = this.manifestPath(ctx);
    const namespace = this.namespace(ctx);

    // Le namespace d'abord, seul : les ressources qui suivent le référencent.
    onLog(`kubectl apply — namespace ${namespace}`);
    await this.stream(
      ctx,
      this.kubectl(`apply -f ${shellQuote(`${release}/${namespaceFilePath(ctx.appSlug)}`)}`),
      onLog,
      'apply_namespace',
      APPLY_TIMEOUT_MS,
    );

    onLog(`kubectl apply -f . -n ${namespace}`);
    await this.stream(
      ctx,
      this.kubectl(`apply -f ${shellQuote(manifests)} -n ${namespace}`),
      onLog,
      'apply',
      APPLY_TIMEOUT_MS,
    );

    for (const service of topologicalOrder(ctx.spec)) {
      onLog(`kubectl rollout status deployment/${service.name}`);
      await this.stream(
        ctx,
        this.kube(ctx, `rollout status deployment/${service.name} --timeout=${ROLLOUT_TIMEOUT}`),
        onLog,
        'rollout',
        APPLY_TIMEOUT_MS,
      );
    }

    // Marque la release courante : `rollback()` et `destroy()` s'en servent.
    await this.run(
      ctx,
      `ln -sfn ${shellQuote(release)} ${shellQuote(`${this.appPath(ctx)}/current`)}`,
      onLog,
      'link',
    );

    // Ménage des anciennes versions, une fois `current` à jour.
    await pruneReleases(ctx, this.appPath(ctx), onLog);

    const url = this.buildUrl(ctx);
    onLog(`déploiement appliqué${url ? ` — ${url}` : ''}`);

    return {
      ok: true,
      url,
      publishedPort: null,
      releasePath: release,
      images: await this.images(ctx),
    };
  }

  /**
   * URL par laquelle l'application doit répondre.
   *
   * Sans `ingress.host`, il n'y a rien à annoncer : le ClusterIP n'est joignable
   * que depuis le cluster. Le driver le dit en retournant `null` plutôt que de
   * fabriquer une URL qui ne répondra jamais.
   */
  private buildUrl(ctx: DriverContext): string | null {
    const ingress = ctx.spec.ingress;
    if (!ingress?.host) return null;
    return `${ingress.tls ? 'https' : 'http'}://${ingress.host}`;
  }

  /**
   * Images effectivement référencées par les manifests.
   *
   * Déduite de l'AppSpec, pas du cluster : la liste doit être connue avant que
   * quoi que ce soit ne tourne, pour que les scanners puissent l'analyser.
   */
  async images(ctx: DriverContext): Promise<string[]> {
    return ctx.spec.services.map((service) =>
      service.source.type === 'image'
        ? service.source.ref
        : builtImageTag(ctx.appSlug, service.name, ctx.spec.version),
    );
  }

  // ─── healthcheck ────────────────────────────────────────────────────────────

  async healthcheck(ctx: DriverContext): Promise<HealthResult> {
    const service = entrypointService(ctx.spec);
    const { retries, intervalSec, timeoutSec } = service.healthcheck;

    const pods = await exec(ctx.sshSession, this.kube(ctx, 'get pods -o json'), {
      timeout: SHORT_TIMEOUT_MS,
    });
    const readiness = pods.code === 0 ? parsePodReadiness(pods.stdout) : null;
    if (readiness === null || readiness.total === 0) {
      return this.unhealthy(ctx, {
        outcome: 'unreachable',
        attempts: 0,
        statusCode: null,
        detail: `aucun pod dans ${this.namespace(ctx)}`,
      });
    }
    if (readiness.ready < readiness.total) {
      return this.unhealthy(
        ctx,
        {
          outcome: 'unreachable',
          attempts: 0,
          statusCode: null,
          detail: `${readiness.ready}/${readiness.total} pod(s) prêt(s)${
            readiness.pending.length > 0 ? ` — en attente : ${readiness.pending.join(', ')}` : ''
          }`,
        },
        readiness.pending,
      );
    }

    const probe = this.probeCommand(ctx, service, timeoutSec);
    let lastStatus: number | null = null;
    let lastDetail: string | null = null;
    let lastOutcome: HealthOutcome = 'unreachable';

    for (let attempt = 1; attempt <= retries; attempt += 1) {
      const result = await exec(ctx.sshSession, probe.command, {
        timeout: (timeoutSec + 30) * 1000,
      });

      const status = Number.parseInt(lastNonEmptyLine(result.stdout) ?? '', 10);
      lastStatus = Number.isNaN(status) || status === 0 ? null : status;
      lastOutcome = lastStatus === null ? 'unreachable' : 'unhealthy';
      lastDetail =
        lastStatus !== null
          ? `HTTP ${lastStatus} sur ${probe.label}`
          : `${probe.label} injoignable ` +
            `(code ${result.code}${firstLine(result.stderr) ? ` : ${firstLine(result.stderr)}` : ''})`;

      if (lastStatus !== null && lastStatus >= 200 && lastStatus < 400) {
        return {
          healthy: true,
          outcome: 'healthy',
          attempts: attempt,
          statusCode: lastStatus,
          detail: `${probe.label} — ${readiness.ready}/${readiness.total} pod(s) prêt(s)`,
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
   * Résultat d'échec, diagnostic capturé **avant** de rendre la main : un
   * rollback qui suivrait remplacerait les pods et effacerait la scène.
   */
  private async unhealthy(
    ctx: DriverContext,
    partial: Omit<HealthResult, 'healthy' | 'diagnostics'>,
    suspects: readonly string[] = [],
  ): Promise<HealthResult> {
    return {
      healthy: false,
      diagnostics: await this.diagnose(ctx, suspects),
      ...partial,
    };
  }

  /**
   * `kubectl get pods`, puis `describe` et `logs` des pods en cause.
   *
   * `describe` avant `logs` : un pod qui ne démarre pas (image absente, volume
   * non lié) n'a aucun log à montrer, et c'est la liste d'événements qui dit
   * pourquoi.
   */
  private async diagnose(
    ctx: DriverContext,
    suspects: readonly string[],
  ): Promise<string | null> {
    const namespace = this.namespace(ctx);
    const sections: string[] = [];

    const pods = await exec(ctx.sshSession, this.kube(ctx, 'get pods -o wide'), {
      timeout: SHORT_TIMEOUT_MS,
    });
    if (pods.stdout.trim().length > 0) {
      sections.push(`$ kubectl -n ${namespace} get pods -o wide\n${pods.stdout.trim()}`);
    }

    // À défaut de pod nommément en cause, on regarde ceux qui ne sont pas
    // `Running` — c'est le même critère, appliqué à la volée.
    const names =
      suspects.length > 0 ? [...suspects] : await this.notRunningPods(ctx);

    for (const name of names.slice(0, DIAGNOSTIC_PODS)) {
      const describe = await exec(ctx.sshSession, this.kube(ctx, `describe pod ${shellQuote(name)}`), {
        timeout: DIAGNOSTIC_TIMEOUT_MS,
      });
      sections.push(
        `$ kubectl -n ${namespace} describe pod ${name}\n${describe.stdout.trim() || describe.stderr.trim()}`,
      );

      const logs = await exec(
        ctx.sshSession,
        this.kube(ctx, `logs ${shellQuote(name)} --all-containers --tail ${DIAGNOSTIC_LINES}`),
        { timeout: DIAGNOSTIC_TIMEOUT_MS },
      );
      const output = `${logs.stdout}\n${logs.stderr}`.trim();
      sections.push(
        `$ kubectl -n ${namespace} logs ${name} --tail ${DIAGNOSTIC_LINES}\n` +
          (output.length > 0 ? output : '(aucune sortie)'),
      );
    }

    return sections.length > 0 ? sections.join('\n\n') : null;
  }

  private async notRunningPods(ctx: DriverContext): Promise<string[]> {
    const result = await exec(
      ctx.sshSession,
      this.kube(
        ctx,
        "get pods -o jsonpath='{range .items[*]}{.metadata.name} {.status.phase}{\"\\n\"}{end}'",
      ),
      { timeout: SHORT_TIMEOUT_MS },
    );

    return result.stdout
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .filter((columns) => columns.length === 2 && columns[1] !== 'Running')
      .map((columns) => columns[0] as string);
  }

  /**
   * Comment sonder l'application depuis le node.
   *
   * Avec un `ingress.host`, on emprunte le vrai chemin — le contrôleur
   * d'ingress — en forçant la résolution du nom vers la boucle locale : la cible
   * n'a aucune raison d'avoir le DNS public de l'application.
   *
   * Sans nom de domaine, rien n'est publié : on ouvre un `port-forward`
   * temporaire vers le Service, on sonde, on referme. Le tout en une commande —
   * une session SSH par sonde, pas de processus qui traîne si elle est coupée.
   */
  private probeCommand(
    ctx: DriverContext,
    service: Service,
    timeoutSec: number,
  ): { command: string; label: string } {
    const path = service.healthcheck.path;
    const ingress = ctx.spec.ingress;

    if (ingress?.host) {
      const tls = ingress.tls;
      const port = tls ? 443 : 80;
      const url = `${tls ? 'https' : 'http'}://${ingress.host}${path}`;
      return {
        label: url,
        command:
          `curl -s -k -o /dev/null -w '%{http_code}' -m ${timeoutSec} ` +
          `--resolve ${shellQuote(`${ingress.host}:${port}:127.0.0.1`)} ${shellQuote(url)}`,
      };
    }

    const namespace = this.namespace(ctx);
    const logFile = `/tmp/tp-portforward-${ctx.deployment.id}.log`;
    const port = service.healthcheck.port ?? service.port;

    return {
      label: `port-forward svc/${service.name}:${port}${path}`,
      command: this.script([
        `rm -f ${shellQuote(logFile)}`,
        // Port local 0 : c'est kubectl qui en choisit un libre et l'annonce.
        `kubectl -n ${namespace} port-forward svc/${service.name} :${port} > ${shellQuote(logFile)} 2>&1 &`,
        'PF=$!',
        'LP=""',
        'for _ in 1 2 3 4 5 6 7 8 9 10; do',
        `  LP=$(sed -n 's/.*127\\.0\\.0\\.1:\\([0-9][0-9]*\\).*/\\1/p' ${shellQuote(logFile)} | head -n 1)`,
        '  [ -n "$LP" ] && break',
        '  sleep 1',
        'done',
        'if [ -z "$LP" ]; then',
        '  kill "$PF" 2>/dev/null',
        `  cat ${shellQuote(logFile)} >&2`,
        `  rm -f ${shellQuote(logFile)}`,
        '  exit 97',
        'fi',
        `curl -s -o /dev/null -w '%{http_code}' -m ${timeoutSec} "http://127.0.0.1:$LP${path}"`,
        'CODE=$?',
        'kill "$PF" 2>/dev/null',
        `rm -f ${shellQuote(logFile)}`,
        'exit $CODE',
      ]),
    };
  }

  // ─── rollback ───────────────────────────────────────────────────────────────

  /**
   * `kubectl rollout undo` sur chaque Deployment.
   *
   * Un Deployment jamais mis à jour n'a qu'une révision : `undo` échoue alors,
   * légitimement. Dans ce cas on réapplique les manifests de la version
   * précédente s'ils sont encore sur la cible — c'est la même sémantique que le
   * driver Docker, qui relance la release précédente.
   */
  async rollback(ctx: DriverContext, onLog: LogSink): Promise<void> {
    const services = topologicalOrder(ctx.spec);
    const failed: string[] = [];

    for (const service of services) {
      onLog(`kubectl rollout undo deployment/${service.name}`);
      const undo = await exec(ctx.sshSession, this.kube(ctx, `rollout undo deployment/${service.name}`), {
        timeout: SHORT_TIMEOUT_MS,
      });
      if (undo.code !== 0) {
        onLog(`  ${firstLine(undo.stderr) ?? `code ${undo.code}`}`);
        failed.push(service.name);
      }
    }

    if (failed.length > 0) {
      const previous = ctx.previousDeployment;
      if (!previous) {
        throw new DriverError(
          `Aucune révision antérieure pour ${failed.join(', ')} et aucun ` +
            '`previousDeployment` dans le contexte : rien vers quoi revenir.',
          this.runtime,
          'rollback',
        );
      }

      const manifests = this.manifestPath(ctx, previous.version);
      const exists = await exec(ctx.sshSession, `test -d ${shellQuote(manifests)}`, {
        timeout: SHORT_TIMEOUT_MS,
      });
      if (exists.code !== 0) {
        throw new DriverError(
          `La version précédente ${previous.version} n'est plus sur la cible (${manifests})`,
          this.runtime,
          'rollback',
        );
      }

      onLog(`→ réapplication des manifests de la version ${previous.version}`);
      await this.stream(
        ctx,
        this.kubectl(`apply -f ${shellQuote(manifests)} -n ${this.namespace(ctx)}`),
        onLog,
        'rollback',
        APPLY_TIMEOUT_MS,
      );

      await this.run(
        ctx,
        `ln -sfn ${shellQuote(this.releasePath(ctx, previous.version))} ${shellQuote(`${this.appPath(ctx)}/current`)}`,
        onLog,
        'link',
      );
    }

    for (const service of services) {
      await this.stream(
        ctx,
        this.kube(ctx, `rollout status deployment/${service.name} --timeout=${ROLLOUT_TIMEOUT}`),
        onLog,
        'rollback',
        APPLY_TIMEOUT_MS,
      );
    }

    onLog('✓ rollback confirmé');
  }

  // ─── destroy ────────────────────────────────────────────────────────────────

  /** Rétention des versions : voir `DeploymentDriver.pruneReleases`. */
  async pruneReleases(ctx: DriverContext, onLog: LogSink, keep?: number): Promise<string[]> {
    return pruneReleases(ctx, this.appPath(ctx), onLog, keep);
  }

  async destroy(ctx: DriverContext, onLog: LogSink): Promise<void> {
    const namespace = this.namespace(ctx);
    const appPath = this.appPath(ctx);

    onLog(`→ kubectl delete namespace ${namespace}`);
    // Supprimer le namespace emporte tout ce qu'il contient, PVC compris.
    // `--ignore-not-found` : détruire une app absente doit rester idempotent.
    await this.stream(
      ctx,
      this.kubectl(
        `delete namespace ${namespace} --ignore-not-found --wait=true --timeout=${ROLLOUT_TIMEOUT}`,
      ),
      onLog,
      'destroy',
      APPLY_TIMEOUT_MS,
      false,
    );

    onLog(`→ suppression de ${appPath}`);
    await this.run(ctx, `rm -rf ${shellQuote(appPath)}`, onLog, 'destroy');

    onLog('✓ déploiement détruit');
  }

  // ─── logs ───────────────────────────────────────────────────────────────────

  // ─── supervision ────────────────────────────────────────────────────────────

  /**
   * État des pods du namespace, ramené au vocabulaire neutre de la supervision.
   * Un Deployment porte plusieurs pods : on rapporte l'état de chacun, préfixé
   * du nom de son Deployment, plutôt que d'inventer une moyenne.
   */
  async status(ctx: DriverContext): Promise<AppStatus> {
    const checkedAt = new Date().toISOString();
    const result = await exec(ctx.sshSession, this.kube(ctx, 'get pods -o json'), {
      timeout: SHORT_TIMEOUT_MS,
      logOutput: false,
    });

    if (result.code !== 0) return { services: [], checkedAt };

    return { services: parsePods(result.stdout), checkedAt };
  }

  /**
   * `kubectl rollout restart` recrée les pods sans toucher aux manifests :
   * mêmes images, mêmes volumes, même Ingress. C'est l'équivalent exact du
   * `docker compose restart` côté Compose.
   */
  async restart(ctx: DriverContext, onLog: LogSink): Promise<void> {
    onLog(`kubectl rollout restart -n ${this.namespace(ctx)}`);

    await this.stream(
      ctx,
      this.kube(ctx, `rollout restart deployment -l '${MANAGED_SELECTOR}'`),
      onLog,
      'restart',
      APPLY_TIMEOUT_MS,
    );

    for (const service of ctx.spec.services) {
      await this.stream(
        ctx,
        this.kube(ctx, `rollout status deployment/${service.name} --timeout=5m`),
        onLog,
        'restart',
        APPLY_TIMEOUT_MS,
      );
    }

    onLog('pods recréés');
  }

  async logs(ctx: DriverContext, onLine: LogSink): Promise<void> {
    await execStream(
      ctx.sshSession,
      this.kube(
        ctx,
        'logs -f --all-containers=true --prefix --tail 200 --max-log-requests 50 ' +
          `-l '${MANAGED_SELECTOR}'`,
      ),
      (line) => onLine(line),
      // Un suivi de logs n'a pas de fin naturelle : c'est l'appelant qui coupe
      // la session quand il a fini.
      { timeout: null, logOutput: false },
    );
  }

  // ─── charges de la cible ────────────────────────────────────────────────────

  /**
   * Tout ce qui tourne sur le cluster.
   *
   * On liste les **contrôleurs** (Deployment, StatefulSet, DaemonSet) et les
   * pods qui n'en ont aucun, pas les pods pilotés. C'est une décision, pas un
   * raccourci : supprimer un pod géré par un Deployment ne supprime rien — le
   * contrôleur en recrée un dans la seconde. Une ligne sur laquelle l'action
   * proposée n'a aucun effet est une ligne qui ment. Ce qu'on montre est donc
   * ce sur quoi on peut agir.
   *
   * Les pods restent la source de l'état affiché : `2/3 prêts` vient d'eux.
   */
  async listWorkloads(ctx: TargetContext): Promise<Workload[]> {
    const result = await exec(
      ctx.sshSession,
      this.kubectl('get deployments,statefulsets,daemonsets,pods --all-namespaces -o json'),
      { timeout: SHORT_TIMEOUT_MS, logOutput: false },
    );

    if (result.code !== 0) {
      throw new DriverError(
        `Inventaire impossible : ${firstLine(result.stderr) ?? `code ${result.code}`}`,
        this.runtime,
        'workload.list',
      );
    }

    return parseWorkloads(result.stdout);
  }

  /**
   * Supprime la ressource désignée. Un contrôleur emporte ses pods ; un pod
   * autonome ne laisse rien derrière lui.
   *
   * Les PVC ne sont pas touchés : ils survivent volontairement à leur
   * contrôleur, exactement comme les volumes nommés côté Docker.
   */
  async removeWorkload(ctx: TargetContext, ref: WorkloadRef, onLog: LogSink): Promise<void> {
    const { workload, resource } = await this.findWorkload(ctx, ref, 'workload.remove');

    if (workload.managed) {
      throw new DriverError(managedWorkloadRefusal(workload), this.runtime, 'workload.remove');
    }

    // Garde propre au runtime : le panel n'a rien à faire dans les namespaces
    // qui font tourner le cluster lui-même. Rien ne les marque « géré par le
    // panel », et pourtant les effacer casserait la machine.
    if (SYSTEM_NAMESPACES.has(resource.namespace)) {
      throw new DriverError(
        `« ${workload.name} » vit dans le namespace système « ${resource.namespace} » : ` +
          'le panel ne supprime pas ce qui fait tourner le cluster.',
        this.runtime,
        'workload.remove',
      );
    }

    onLog(`→ kubectl -n ${resource.namespace} delete ${resource.kind}/${resource.name}`);
    await this.stream(
      ctx,
      this.kubectl(
        `-n ${resource.namespace} delete ${resource.kind} ${resource.name} ` +
          `--wait=true --timeout=${ROLLOUT_TIMEOUT}`,
      ),
      onLog,
      'workload.remove',
      APPLY_TIMEOUT_MS,
    );
    onLog('✓ charge supprimée — les PVC du namespace sont conservés');
  }

  /**
   * Mettre à jour, en Kubernetes, veut dire exactement ceci :
   *
   *   1. `kubectl rollout restart` sur le contrôleur — il recrée ses pods à
   *      partir du **même** manifeste : mêmes images, mêmes volumes, même
   *      service, même ingress ;
   *   2. `kubectl rollout status` pour attendre que le remplacement soit
   *      effectif, et échouer si les nouveaux pods ne démarrent pas.
   *
   * L'image est retirée du registry par le kubelet à la recréation lorsque la
   * politique de tirage le permet — `imagePullPolicy: Always`, ou un tag absent
   * du node. Le panel ne modifie pas le manifeste pour forcer le tirage :
   * changer `imagePullPolicy` serait changer la configuration, précisément ce
   * que cette opération promet de ne pas faire. C'est la différence assumée
   * avec Docker, où le `pull` est explicite parce qu'il n'y a personne d'autre
   * pour le décider.
   *
   * Un pod sans contrôleur n'est pas mis à jour : rien ne le recréerait.
   */
  async updateWorkload(ctx: TargetContext, ref: WorkloadRef, onLog: LogSink): Promise<void> {
    const { workload, resource } = await this.findWorkload(ctx, ref, 'workload.update');

    if (workload.managed) {
      throw new DriverError(
        `« ${workload.name} » est déployée par le panel : sa mise à jour est un ` +
          'redéploiement, pas une recréation à la main. Passez par un nouveau déploiement.',
        this.runtime,
        'workload.update',
      );
    }

    if (resource.kind === 'pod') {
      throw new DriverError(
        `« ${workload.name} » est un pod sans contrôleur : personne ne le recréerait ` +
          'après sa suppression. Le panel ne le met pas à jour.',
        this.runtime,
        'workload.update',
      );
    }

    const path = `${resource.kind}/${resource.name}`;
    onLog(`→ kubectl -n ${resource.namespace} rollout restart ${path}`);
    await this.stream(
      ctx,
      this.kubectl(`-n ${resource.namespace} rollout restart ${path}`),
      onLog,
      'workload.update',
      APPLY_TIMEOUT_MS,
    );

    onLog(`→ kubectl -n ${resource.namespace} rollout status ${path}`);
    await this.stream(
      ctx,
      this.kubectl(`-n ${resource.namespace} rollout status ${path} --timeout=${ROLLOUT_TIMEOUT}`),
      onLog,
      'workload.update',
      APPLY_TIMEOUT_MS,
    );
    onLog('✓ pods recréés sur le manifeste courant');
  }

  /** Relit une charge sur le cluster, et refuse d'agir à l'aveugle. */
  private async findWorkload(
    ctx: TargetContext,
    ref: WorkloadRef,
    step: string,
  ): Promise<{ workload: Workload; resource: K3sResourceRef }> {
    const resource = parseResourceRef(ref.id);
    if (!resource) {
      throw new DriverError(`Référence de charge illisible : « ${ref.id} »`, this.runtime, step);
    }

    const result = await exec(
      ctx.sshSession,
      this.kubectl(`-n ${resource.namespace} get ${resource.kind} ${resource.name} -o json`),
      { timeout: SHORT_TIMEOUT_MS, logOutput: false },
    );

    if (result.code !== 0) {
      throw new DriverError(
        `Aucune charge « ${ref.id} » sur cette cible : ` +
          `${firstLine(result.stderr) ?? `code ${result.code}`}`,
        this.runtime,
        step,
      );
    }

    const workload = parseSingleWorkload(result.stdout, resource);
    if (!workload) {
      throw new DriverError(`Charge « ${ref.id} » illisible`, this.runtime, step);
    }

    return { workload, resource };
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
    sudo = false,
  ): Promise<void> {
    const result = await execStream(ctx.sshSession, command, (line) => onLog(line), {
      timeout,
      logOutput: false,
      sudo,
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

/**
 * Ces quelques fonctions existent aussi dans le driver Docker. C'est volontaire :
 * un driver ne dépend pas d'un autre driver. Le jour où l'un change de shell ou
 * de format de sortie, l'autre n'en sait rien.
 */

/** Échappement POSIX en quotes simples. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function firstLine(value: string): string | null {
  const line = value.split('\n').find((candidate) => candidate.trim().length > 0);
  return line?.trim() ?? null;
}

/** Dernière ligne non vide : la sonde imprime son code après le bruit de kubectl. */
function lastNonEmptyLine(value: string): string | null {
  const lines = value.split('\n').filter((line) => line.trim().length > 0);
  return lines[lines.length - 1]?.trim() ?? null;
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

type KubeCondition = { type?: string; status?: string };

type NodeItem = {
  status?: {
    conditions?: KubeCondition[];
    nodeInfo?: { kubeletVersion?: string };
  };
};

/** `kubectl get nodes -o json` : nombre de nodes, nodes prêts, version. */
export function parseNodes(
  output: string,
): { nodes: number; readyNodes: number; version: string | null } | null {
  let parsed: { items?: NodeItem[] };
  try {
    parsed = JSON.parse(output) as { items?: NodeItem[] };
  } catch {
    return null;
  }

  const items = parsed.items;
  if (!Array.isArray(items)) return null;

  const readyNodes = items.filter((item) =>
    item.status?.conditions?.some(
      (condition) => condition.type === 'Ready' && condition.status === 'True',
    ),
  ).length;

  return {
    nodes: items.length,
    readyNodes,
    version: items[0]?.status?.nodeInfo?.kubeletVersion ?? null,
  };
}

type PodItem = {
  metadata?: { name?: string };
  status?: { conditions?: KubeCondition[]; phase?: string };
};

/** `kubectl get pods -o json` : combien sont prêts, et lesquels ne le sont pas. */
export function parsePodReadiness(
  output: string,
): { total: number; ready: number; pending: string[] } | null {
  let parsed: { items?: PodItem[] };
  try {
    parsed = JSON.parse(output) as { items?: PodItem[] };
  } catch {
    return null;
  }

  const items = parsed.items;
  if (!Array.isArray(items)) return null;

  const pending: string[] = [];
  let ready = 0;

  for (const item of items) {
    const isReady =
      item.status?.conditions?.some(
        (condition) => condition.type === 'Ready' && condition.status === 'True',
      ) ?? false;
    // Un pod terminé avec succès n'a pas à être « Ready » : il a fini son travail.
    if (isReady || item.status?.phase === 'Succeeded') {
      ready += 1;
    } else {
      pending.push(item.metadata?.name ?? '?');
    }
  }

  return { total: items.length, ready, pending };
}


type PodJson = {
  items?: Array<{
    metadata?: { name?: string; labels?: Record<string, string> };
    status?: {
      phase?: string;
      startTime?: string;
      containerStatuses?: Array<{ ready?: boolean; image?: string; restartCount?: number }>;
    };
  }>;
};

/** Phase Kubernetes → vocabulaire neutre. */
function toServiceState(phase: string, ready: boolean): ServiceState {
  switch (phase) {
    case 'Running':
      return ready ? 'running' : 'restarting';
    case 'Pending':
      return 'created';
    case 'Succeeded':
    case 'Failed':
      return 'exited';
    default:
      return 'unknown';
  }
}

function parsePods(json: string): ServiceStatus[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }

  const payload = parsed as PodJson;
  if (!Array.isArray(payload.items)) return [];

  return payload.items.map((pod) => {
    const containers = pod.status?.containerStatuses ?? [];
    const ready = containers.length > 0 && containers.every((c) => c.ready === true);
    const phase = pod.status?.phase ?? 'Unknown';
    const restarts = containers.reduce((sum, c) => sum + (c.restartCount ?? 0), 0);

    return {
      name:
        pod.metadata?.labels?.['app.kubernetes.io/name'] ??
        pod.metadata?.name ??
        'inconnu',
      state: toServiceState(phase, ready),
      health: ready ? ('healthy' as const) : phase === 'Running' ? ('starting' as const) : ('none' as const),
      since: pod.status?.startTime
        ? `${phase}${restarts > 0 ? ` · ${restarts} redémarrage(s)` : ''}`
        : phase,
      image: containers[0]?.image ?? null,
      ports: [],
    };
  });
}

// ─── charges de la cible : lecture de Kubernetes ──────────────────────────────

/**
 * Namespaces qui font tourner le cluster. Rien n'y porte le label du panel, et
 * pourtant y supprimer quoi que ce soit casserait la machine : la garde est
 * ici, dans le driver, parce que c'est une particularité de ce runtime.
 */
const SYSTEM_NAMESPACES = new Set(['kube-system', 'kube-public', 'kube-node-lease']);

/** Genres de charges pilotables, dans le vocabulaire de `kubectl`. */
const CONTROLLER_KINDS: Record<string, string> = {
  Deployment: 'deployment',
  StatefulSet: 'statefulset',
  DaemonSet: 'daemonset',
};

export type K3sResourceRef = { namespace: string; kind: string; name: string };

/**
 * Poignée d'une charge K3s : `namespace:kind:name`.
 *
 * Le `:` convient : il est licite dans un segment d'URL et interdit dans un nom
 * DNS-1123, donc dans un nom de ressource Kubernetes. Aucune ambiguïté possible
 * au découpage.
 */
export function encodeResourceRef(resource: K3sResourceRef): string {
  return `${resource.namespace}:${resource.kind}:${resource.name}`;
}

export function parseResourceRef(raw: string): K3sResourceRef | null {
  const parts = raw.split(':');
  if (parts.length !== 3) return null;

  const [namespace, kind, name] = parts;
  if (!namespace || !kind || !name) return null;
  if (kind !== 'pod' && !Object.values(CONTROLLER_KINDS).includes(kind)) return null;

  return { namespace, kind, name };
}

type KubeMeta = {
  name?: string;
  namespace?: string;
  labels?: Record<string, string> | null;
  creationTimestamp?: string;
  ownerReferences?: Array<{ kind?: string; name?: string }> | null;
};

type KubeContainerSpec = { image?: string; ports?: Array<{ hostPort?: number; containerPort?: number; protocol?: string }> | null };

type KubeItem = {
  kind?: string;
  metadata?: KubeMeta;
  spec?: {
    replicas?: number;
    template?: { spec?: { containers?: KubeContainerSpec[] | null } | null } | null;
    containers?: KubeContainerSpec[] | null;
  } | null;
  status?: {
    replicas?: number;
    readyReplicas?: number;
    availableReplicas?: number;
    desiredNumberScheduled?: number;
    numberReady?: number;
    phase?: string;
    startTime?: string;
    conditions?: KubeCondition[] | null;
    containerStatuses?: Array<{ ready?: boolean; image?: string; restartCount?: number }> | null;
  } | null;
};

function kubeItems(json: string): KubeItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }

  const payload = parsed as { items?: KubeItem[] };
  return Array.isArray(payload.items) ? payload.items : [];
}

/** Ports publiés sur le **node**. En Kubernetes c'est rare : l'exposition
 * normale passe par un Service et un Ingress, qui n'appartiennent pas à la
 * charge. On ne rapporte donc que les `hostPort` réellement déclarés, plutôt
 * que d'inventer une correspondance qui n'existe pas. */
function hostPorts(containers: KubeContainerSpec[] | null | undefined): string[] {
  const out: string[] = [];
  for (const container of containers ?? []) {
    for (const port of container.ports ?? []) {
      if (!port.hostPort) continue;
      const entry = `${port.hostPort}→${port.containerPort ?? port.hostPort}/${(port.protocol ?? 'TCP').toLowerCase()}`;
      if (!out.includes(entry)) out.push(entry);
    }
  }
  return out;
}

function isManaged(meta: KubeMeta | undefined): boolean {
  // Les deux générations, pour la même raison que les sélecteurs : une
  // ressource posée avant le renommage appartient toujours au panel.
  const managedBy = (meta?.labels ?? {})['app.kubernetes.io/managed-by'];
  return managedBy === MANAGED_BY || managedBy === LEGACY_MANAGED_BY;
}

function managedApp(meta: KubeMeta | undefined): string | null {
  const labels = meta?.labels ?? {};
  return labels['app.kubernetes.io/part-of'] ?? labels['app.kubernetes.io/instance'] ?? null;
}

/** Un contrôleur est « en marche » quand toutes ses répliques attendues le sont. */
function controllerState(item: KubeItem): { state: ServiceState; since: string } {
  const status = item.status ?? {};
  const desired =
    item.kind === 'DaemonSet'
      ? (status.desiredNumberScheduled ?? 0)
      : (item.spec?.replicas ?? status.replicas ?? 0);
  const ready = item.kind === 'DaemonSet' ? (status.numberReady ?? 0) : (status.readyReplicas ?? 0);

  const since = `${ready}/${desired} prêt${desired > 1 ? 's' : ''}`;

  // Zéro réplique voulue n'est pas une panne : c'est une charge délibérément
  // mise à l'arrêt, l'équivalent d'un conteneur `exited`.
  if (desired === 0) return { state: 'exited', since: 'mis à l’échelle zéro' };
  if (ready >= desired) return { state: 'running', since };
  if (ready === 0) return { state: 'created', since };
  return { state: 'restarting', since };
}

function toControllerWorkload(item: KubeItem, kind: string): Workload | null {
  const meta = item.metadata;
  if (!meta?.name || !meta.namespace) return null;

  const containers = item.spec?.template?.spec?.containers ?? null;
  const { state, since } = controllerState(item);
  const ready = state === 'running';

  return {
    runtime: 'k3s',
    id: encodeResourceRef({ namespace: meta.namespace, kind, name: meta.name }),
    name: meta.name,
    kind,
    scope: meta.namespace,
    image: containers?.[0]?.image ?? null,
    state,
    health: ready ? 'healthy' : state === 'exited' ? 'none' : 'starting',
    createdAt: meta.creationTimestamp ?? null,
    since,
    ports: hostPorts(containers),
    managed: isManaged(meta),
    managedApp: managedApp(meta),
  };
}

function toPodWorkload(item: KubeItem): Workload | null {
  const meta = item.metadata;
  if (!meta?.name || !meta.namespace) return null;

  const statuses = item.status?.containerStatuses ?? [];
  const ready = statuses.length > 0 && statuses.every((container) => container.ready === true);
  const phase = item.status?.phase ?? 'Unknown';
  const restarts = statuses.reduce((sum, container) => sum + (container.restartCount ?? 0), 0);

  return {
    runtime: 'k3s',
    id: encodeResourceRef({ namespace: meta.namespace, kind: 'pod', name: meta.name }),
    name: meta.name,
    kind: 'pod',
    scope: meta.namespace,
    image: statuses[0]?.image ?? item.spec?.containers?.[0]?.image ?? null,
    state: toServiceState(phase, ready),
    health: ready ? 'healthy' : phase === 'Running' ? 'starting' : 'none',
    createdAt: meta.creationTimestamp ?? null,
    since: `${phase}${restarts > 0 ? ` · ${restarts} redémarrage(s)` : ''}`,
    ports: hostPorts(item.spec?.containers ?? null),
    managed: isManaged(meta),
    managedApp: managedApp(meta),
  };
}

/**
 * `kubectl get deployments,statefulsets,daemonsets,pods -A -o json` → charges.
 * Les pods pilotés par un contrôleur sont écartés : leur ligne serait un leurre.
 */
export function parseWorkloads(json: string): Workload[] {
  const workloads: Workload[] = [];

  for (const item of kubeItems(json)) {
    const controllerKind = CONTROLLER_KINDS[item.kind ?? ''];
    if (controllerKind) {
      const workload = toControllerWorkload(item, controllerKind);
      if (workload) workloads.push(workload);
      continue;
    }

    if (item.kind !== 'Pod') continue;
    if ((item.metadata?.ownerReferences ?? []).length > 0) continue;

    const workload = toPodWorkload(item);
    if (workload) workloads.push(workload);
  }

  return workloads;
}

/** `kubectl get <kind> <name> -o json` → une charge, ou rien. */
export function parseSingleWorkload(json: string, resource: K3sResourceRef): Workload | null {
  let item: KubeItem;
  try {
    item = JSON.parse(json) as KubeItem;
  } catch {
    return null;
  }

  return resource.kind === 'pod' ? toPodWorkload(item) : toControllerWorkload(item, resource.kind);
}
