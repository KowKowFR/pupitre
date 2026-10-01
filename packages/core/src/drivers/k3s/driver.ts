import { exec, execPipe, execStream, upload } from '../../ssh/client.js';
import type { Readable, Writable } from 'node:stream';
import { storedSecretNames, topologicalOrder, type Service } from '../../spec/index.js';
import { backoffMs } from '../backoff.js';
import type { AppStatus, ServiceState, ServiceStatus } from '../../supervision.js';
import { pruneReleases } from '../retention.js';
import { extractSourceArchive } from '../source-archive.js';
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
import { digestOf, parseImageReference } from '../../images/reference.js';
import { checkableImages, type RunningImage } from '../../images/updates.js';
import {
  managedWorkloadControlRefusal,
  managedWorkloadRefusal,
  type Workload,
  type WorkloadControlAction,
  type WorkloadRef,
} from '../../workloads.js';
import {
  quoteForShell,
  runBoundedExec,
  type WorkloadExecOptions,
  type WorkloadExecResult,
} from '../workload-exec.js';
import {
  LEGACY_MANAGED_BY,
  MANAGED_BY,
  MANAGED_SELECTOR,
  MANIFEST_DIR,
  buildableServices,
  builtImageTag,
  entrypointService,
  namespaceFilePath,
  namespaceName,
  pvcName,
  renderFiles,
} from './render.js';
import {
  BUILDER_DEPLOYMENT,
  BUILDER_NAMESPACE,
  BUILDKIT_IMAGE,
  applyManifestCommand,
  buildCommand,
  builderAdmissionProbeManifest,
  builderDeploymentManifest,
  builderNamespaceManifest,
  discardTarCommand,
  importCommand,
  pushContextCommand,
  rolloutStatusCommand,
} from './builder.js';

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
 * - le build ne pousse rien vers un registry : l'image est construite **dans le
 *   cluster**, par un BuildKit que le driver y pose lui-même, puis importée
 *   dans le containerd du nœud. Voir `builder.ts` pour le pourquoi de ce
 *   montage.
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
 * Attente de la disparition des pods après un passage à zéro réplique.
 * Deux minutes au total : de quoi laisser un `terminationGracePeriodSeconds`
 * par défaut (30 s) s'écouler plusieurs fois sans immobiliser un slot de worker.
 */
const DRAIN_ATTEMPTS = 60;
const DRAIN_INTERVAL_SECONDS = 2;

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

    checks.push(await this.checkBuildCapability(ctx));

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
   * Ce cluster acceptera-t-il de construire les images que l'AppSpec réclame ?
   *
   * La question est posée **au preflight**, et non à l'étape `build`. Le
   * calendrier est tout l'intérêt : `build` vient après `upload`, donc après
   * que les manifests — Secret rendus en clair compris — ont été déposés sur la
   * cible. Un refus à ce moment-là laisse derrière lui exactement ce qu'on
   * cherchait à ne pas y mettre. Le preflight, lui, a déjà l'AppSpec sous la
   * main et n'a encore rien écrit.
   *
   * On ne demande pas au cluster s'il est « capable » dans l'absolu : on lui
   * soumet le constructeur en `--dry-run=server`, et on prend sa réponse. C'est
   * la seule qui fasse autorité — elle passe par les mêmes RBAC et le même
   * contrôle d'admission que ce qu'on créera vraiment, PodSecurity compris,
   * qui est ce qui refuserait le pod privilégié dont BuildKit a besoin.
   */
  private async checkBuildCapability(
    ctx: DriverContext,
  ): Promise<PreflightResult['checks'][number]> {
    const label = "Construction d'images";
    const buildable = buildableServices(ctx.spec);
    if (buildable.length === 0) {
      return {
        key: 'image_build',
        label,
        ok: true,
        detail: 'aucun service ne se construit depuis un Dockerfile',
      };
    }

    const names = buildable.map((service) => `« ${service.name} »`).join(', ');

    // Le namespace est créé pour de bon, pas en dry-run : un `--dry-run=server`
    // sur un Deployment dont le namespace n'existe pas répond « namespaces not
    // found » — c'est-à-dire rien sur les droits ni sur l'admission. Mesuré sur
    // la cible de test. Un namespace vide est une trace sans commune mesure
    // avec les Secret rendus que ce contrôle évite d'écrire sur la machine.
    const namespace = await exec(
      ctx.sshSession,
      this.script([applyManifestCommand(builderNamespaceManifest())]),
      { timeout: SHORT_TIMEOUT_MS },
    );
    if (namespace.code !== 0) {
      return {
        key: 'image_build',
        label,
        ok: false,
        detail:
          `${names} à construire, et le namespace ${BUILDER_NAMESPACE} du constructeur ` +
          `est refusé : ${firstLine(namespace.stderr) ?? `code ${namespace.code}`}`,
      };
    }

    // Le Deployment pour les droits et le schéma, le Pod pour l'admission :
    // PodSecurity valide des Pods, et se contente d'un avertissement sur un
    // contrôleur. Les deux, ou le contrôle ne prouve que la moitié.
    const admission = await exec(
      ctx.sshSession,
      // `set -e` : sans lui, le code de sortie serait celui du dernier `apply`
      // et un refus sur le premier passerait pour un succès.
      this.script([
        'set -e',
        applyManifestCommand(builderDeploymentManifest(), true),
        applyManifestCommand(builderAdmissionProbeManifest(), true),
      ]),
      { timeout: SHORT_TIMEOUT_MS },
    );

    return {
      key: 'image_build',
      label,
      ok: admission.code === 0,
      detail:
        admission.code === 0
          ? `${names} — constructeur ${BUILDKIT_IMAGE} accepté dans ${BUILDER_NAMESPACE}`
          : `${names} à construire, et le cluster refuse le constructeur ` +
            `(${BUILDKIT_IMAGE}, pod privilégié) : ` +
            `${firstLine(admission.stderr) ?? `code ${admission.code}`}`,
    };
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

    // Le code d'un dépôt lié d'abord : les artefacts rendus passent après, et
    // l'emportent sur un fichier du dépôt qui porterait le même nom.
    if (ctx.sourceArchive) {
      await extractSourceArchive(ctx.sshSession, release, ctx.sourceArchive, onLog, this.runtime);
    }

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
   * Construit dans le cluster, puis importe dans le containerd du nœud.
   *
   * Décision figée du projet : pas de registry. L'image n'est donc jamais
   * poussée nulle part — elle naît et vit sur la machine qui l'exécute. Ce que
   * le nœud n'a pas, c'est un constructeur : `builder.ts` explique lequel on
   * pose, et pourquoi celui-là.
   *
   * `null` quand aucun service ne se construit : l'étape est alors `skipped`.
   */
  async build(ctx: DriverContext, onLog: LogSink): Promise<string[] | null> {
    const buildable = buildableServices(ctx.spec);
    if (buildable.length === 0) return null;

    await this.ensureBuilder(ctx, onLog);

    const release = this.releasePath(ctx);
    const tags: string[] = [];

    for (const service of buildable) {
      const source = service.source;
      if (source.type !== 'dockerfile') continue;
      const tag = builtImageTag(ctx.appSlug, service.name, ctx.spec.version);
      const context = `${release}/${source.context}`;

      onLog(`→ envoi du contexte de « ${service.name} » au constructeur`);
      await this.stream(
        ctx,
        this.script([pushContextCommand(context)]),
        onLog,
        'build',
        BUILD_TIMEOUT_MS,
      );

      onLog(`buildctl build ${tag} (${service.name})`);
      await this.stream(
        ctx,
        this.script([buildCommand(tag, source.dockerfile)]),
        onLog,
        'build',
        BUILD_TIMEOUT_MS,
      );

      // Sans cet import, l'image n'existe que dans un tar à l'intérieur du pod
      // constructeur : le kubelet irait la chercher sur docker.io et le pod
      // resterait en ImagePullBackOff.
      onLog(`k3s ctr -n k8s.io images import ${tag}`);
      await this.stream(
        ctx,
        this.script([importCommand()]),
        onLog,
        'image_import',
        BUILD_TIMEOUT_MS,
        true,
        true,
      );

      // Le tar a fait son office ; il pèse le poids de l'image. Son effacement
      // n'est pas bloquant : l'image est déjà dans containerd à ce point.
      await this.stream(
        ctx,
        this.script([discardTarCommand()]),
        onLog,
        'build',
        SHORT_TIMEOUT_MS,
        false,
      );

      tags.push(tag);
    }

    return tags;
  }

  /**
   * Pose le constructeur dans le cluster, ou le retrouve s'il y est déjà.
   *
   * Il n'est pas retiré après le build, et c'est délibéré : son cache de
   * couches vit dans le pod, et le détruire ferait retélécharger chaque image
   * de base à chaque déploiement. Il ne se rattache à aucune application —
   * `destroy()` d'une app ne doit donc pas l'emporter — et la commande pour
   * s'en défaire est journalisée à chaque passage plutôt que cachée dans une
   * documentation.
   */
  private async ensureBuilder(ctx: DriverContext, onLog: LogSink): Promise<void> {
    onLog(`→ constructeur ${BUILDER_DEPLOYMENT} (${BUILDKIT_IMAGE}) dans ${BUILDER_NAMESPACE}`);
    await this.stream(
      ctx,
      this.script([
        applyManifestCommand(builderNamespaceManifest()),
        applyManifestCommand(builderDeploymentManifest()),
      ]),
      onLog,
      'builder',
      APPLY_TIMEOUT_MS,
    );

    await this.stream(
      ctx,
      this.script([rolloutStatusCommand(ROLLOUT_TIMEOUT)]),
      onLog,
      'builder',
      APPLY_TIMEOUT_MS,
    );

    onLog(
      `   il reste en place pour garder son cache — « kubectl delete namespace ` +
        `${BUILDER_NAMESPACE} » le retire`,
    );
  }

  // ─── deploy ─────────────────────────────────────────────────────────────────

  async deploy(ctx: DriverContext, onLog: LogSink): Promise<DeployResult> {
    const release = this.releasePath(ctx);
    const manifests = this.manifestPath(ctx);
    const namespace = this.namespace(ctx);

    // L'équivalent de `docker compose pull` : sans lui, `IfNotPresent` garde
    // indéfiniment le premier contenu tiré pour un tag.
    const pulled = await this.pullImages(ctx, onLog);

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

    await this.refreshStaleImages(ctx, pulled, onLog);

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

  /**
   * Arrêt : `kubectl scale --replicas=0` sur les Deployments de l'application.
   *
   * Le pendant de `docker compose stop`, et le seul candidat sérieux. Les
   * autres façons d'« arrêter » en Kubernetes suppriment quelque chose :
   * `delete deployment` perd l'objet et son historique de révisions — donc
   * `rollback()` —, `delete namespace` c'est `destroy()`. Mettre le nombre de
   * répliques à zéro ne touche ni les manifests, ni les PVC, ni le Service, ni
   * l'Ingress : le contrôleur retire les pods, et c'est tout.
   *
   * Le sélecteur est le même que celui de `restart()` et de `logs()` : c'est la
   * signature du panel sur le cluster, et elle reconnaît les deux générations
   * d'étiquettes.
   *
   * L'attente est explicite. `rollout status` sur un Deployment à zéro réplique
   * rend la main immédiatement — il constate qu'il n'y a rien à déployer, pas
   * que les pods sont partis. Or un `stop()` qui rend la main pendant que les
   * pods terminent laisserait l'appelant sonder un état intermédiaire et
   * conclure de travers. On boucle donc sur le décompte des pods, ce que
   * `kubectl wait --for=delete` ne sait pas faire proprement quand la liste est
   * déjà vide (il sort en erreur sur « no matching resources found »).
   */
  async stop(ctx: DriverContext, onLog: LogSink): Promise<void> {
    const namespace = this.namespace(ctx);
    onLog(`kubectl scale --replicas=0 -n ${namespace}`);

    await this.stream(
      ctx,
      this.kube(ctx, `scale deployment -l '${MANAGED_SELECTOR}' --replicas=0`),
      onLog,
      'stop',
      APPLY_TIMEOUT_MS,
    );

    await this.stream(
      ctx,
      this.script([
        `for attempt in $(seq 1 ${DRAIN_ATTEMPTS}); do`,
        `  remaining=$(kubectl -n ${namespace} get pods -l '${MANAGED_SELECTOR}' ` +
          `--no-headers 2>/dev/null | wc -l | tr -d ' ')`,
        '  if [ "$remaining" = "0" ]; then echo "pods retirés"; exit 0; fi',
        '  echo "  $remaining pod(s) en cours de terminaison"',
        `  sleep ${DRAIN_INTERVAL_SECONDS}`,
        'done',
        'echo "des pods terminent encore après le délai imparti" >&2',
        'exit 1',
      ]),
      onLog,
      'stop',
      APPLY_TIMEOUT_MS,
    );

    onLog('répliques à zéro — PVC, Service et Ingress conservés');
  }

  /**
   * Démarrage : on remet à chaque Deployment le nombre de répliques que
   * l'AppSpec lui donne, service par service.
   *
   * Pas un `kubectl apply` des manifests, bien qu'il rétablirait aussi les
   * répliques : appliquer, c'est réécrire l'intégralité des objets, donc
   * effacer sans le dire ce qu'un opérateur aurait ajusté sur le cluster depuis
   * le déploiement. Démarrer n'est pas redéployer. `scale` ne touche qu'au
   * champ qu'on a mis à zéro.
   *
   * Service par service et non par sélecteur, parce que le nombre de répliques
   * est propre à chaque service : un sélecteur ne saurait en remettre qu'un
   * seul et le même pour tous. L'ordre topologique est celui de `deploy()` —
   * une base démarre avant ce qui l'interroge.
   */
  async start(ctx: DriverContext, onLog: LogSink): Promise<void> {
    const services = topologicalOrder(ctx.spec);
    onLog(`kubectl scale -n ${this.namespace(ctx)} — ${services.length} service(s)`);

    for (const service of services) {
      await this.stream(
        ctx,
        this.kube(ctx, `scale deployment/${service.name} --replicas=${service.replicas}`),
        onLog,
        'start',
        APPLY_TIMEOUT_MS,
      );
    }

    for (const service of services) {
      await this.stream(
        ctx,
        this.kube(ctx, `rollout status deployment/${service.name} --timeout=${ROLLOUT_TIMEOUT}`),
        onLog,
        'start',
        APPLY_TIMEOUT_MS,
      );
    }

    onLog('pods prêts');
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

  async runningImages(ctx: DriverContext): Promise<RunningImage[]> {
    const result = await exec(ctx.sshSession, this.kube(ctx, 'get pods -o json'), {
      timeout: SHORT_TIMEOUT_MS,
      logOutput: false,
    });
    return result.code === 0 ? parsePodImages(result.stdout) : [];
  }

  // ─── sauvegardes ────────────────────────────────────────────────────────────

  private async pipeOrFail(
    ctx: DriverContext,
    command: string,
    step: string,
    streams: { stdout?: Writable; stdin?: Readable },
  ): Promise<void> {
    const result = await execPipe(ctx.sshSession, this.script([command]), streams);
    if (result.timedOut)
      throw new DriverError(`« ${step} » a dépassé son délai`, this.runtime, step);
    if (result.code !== 0) {
      const lines = result.stderr
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      throw new DriverError(
        `Échec de « ${step} » (code ${result.code}) : ${lines.at(-1) ?? 'sans détail'}`,
        this.runtime,
        step,
      );
    }
  }

  /**
   * Un pod éphémère monte le PVC du volume et en sort l'archive — ou y
   * extrait celle qu'on lui donne. Le planificateur le place de lui-même sur le
   * nœud du volume (`local-path` est `ReadWriteOnce` : par nœud, pas par pod).
   * Le pod est **toujours** supprimé, réussite ou échec.
   */
  private async withVolumePod<T>(
    ctx: DriverContext,
    service: string,
    volume: string,
    readOnly: boolean,
    run: (pod: string) => Promise<T>,
  ): Promise<T> {
    const namespace = this.namespace(ctx);
    const pod = `pupitre-backup-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const manifest = JSON.stringify({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: pod,
        namespace,
        labels: { 'app.kubernetes.io/managed-by': MANAGED_BY, 'pupitre.io/role': 'backup' },
      },
      spec: {
        restartPolicy: 'Never',
        terminationGracePeriodSeconds: 0,
        containers: [
          {
            name: 'helper',
            image: BACKUP_HELPER_IMAGE,
            imagePullPolicy: 'IfNotPresent',
            command: ['sleep', '86400'],
            volumeMounts: [{ name: 'data', mountPath: '/data', readOnly }],
          },
        ],
        volumes: [{ name: 'data', persistentVolumeClaim: { claimName: pvcName(service, volume) } }],
      },
    });
    const step = readOnly ? 'backup.volume' : 'restore.volume';
    try {
      await this.stream(
        ctx,
        this.script([applyManifestCommand(manifest)]),
        () => {},
        step,
        SHORT_TIMEOUT_MS,
      );
      await this.stream(
        ctx,
        this.kubectl(`-n ${namespace} wait --for=condition=Ready pod/${pod} --timeout=180s`),
        () => {},
        step,
        APPLY_TIMEOUT_MS,
      );
      return await run(pod);
    } finally {
      await exec(
        ctx.sshSession,
        this.kubectl(`-n ${namespace} delete pod ${pod} --wait=false --grace-period=0`),
        { timeout: SHORT_TIMEOUT_MS, logOutput: false },
      ).catch(() => undefined);
    }
  }

  async exportVolume(
    ctx: DriverContext,
    service: string,
    volume: string,
    sink: Writable,
  ): Promise<void> {
    await this.withVolumePod(ctx, service, volume, true, (pod) =>
      this.pipeOrFail(
        ctx,
        `kubectl -n ${this.namespace(ctx)} exec ${pod} -- tar czf - -C /data .`,
        'backup.volume',
        { stdout: sink },
      ),
    );
  }

  async importVolume(
    ctx: DriverContext,
    service: string,
    volume: string,
    source: Readable,
  ): Promise<void> {
    await this.withVolumePod(ctx, service, volume, false, (pod) =>
      this.pipeOrFail(
        ctx,
        `kubectl -n ${this.namespace(ctx)} exec -i ${pod} -- sh -c ${shellQuote(CLEAR_AND_EXTRACT)}`,
        'restore.volume',
        { stdin: source },
      ),
    );
  }

  /** Dans un pod du service : `kubectl exec` sur le Deployment en choisit un. */
  async exportFromService(
    ctx: DriverContext,
    service: string,
    command: string,
    sink: Writable,
  ): Promise<void> {
    await this.pipeOrFail(
      ctx,
      `kubectl -n ${this.namespace(ctx)} exec deployment/${service} -- sh -c ${shellQuote(command)}`,
      'backup.dump',
      { stdout: sink },
    );
  }

  async importIntoService(
    ctx: DriverContext,
    service: string,
    command: string,
    source: Readable,
  ): Promise<void> {
    await this.pipeOrFail(
      ctx,
      `kubectl -n ${this.namespace(ctx)} exec -i deployment/${service} -- sh -c ${shellQuote(command)}`,
      'restore.dump',
      { stdin: source },
    );
  }

  /**
   * Tire les images des registres avant d'appliquer les manifests, et retient
   * le digest obtenu pour chaque service.
   *
   * `imagePullPolicy: IfNotPresent` est imposé par les images construites sur
   * la cible (elles n'existent dans aucun registre). Son revers : un tag déjà
   * présent n'est jamais retiré, et `postgres:16` resterait figé sur son
   * premier contenu. Tirer ici rend au tag son contenu actuel dans containerd —
   * exactement ce que fait `docker compose pull` de l'autre côté.
   *
   * Un échec n'arrête pas le déploiement : l'image locale, si elle existe,
   * fera l'affaire, et si elle n'existe pas le rollout le dira.
   */
  private async pullImages(ctx: DriverContext, onLog: LogSink): Promise<Map<string, string>> {
    const pulled = new Map<string, string>();
    for (const { service, image, ref } of checkableImages(ctx.spec)) {
      if (ref.digest) continue;
      onLog(`k3s crictl pull ${image}`);
      const result = await exec(
        ctx.sshSession,
        this.script([
          `k3s crictl pull ${shellQuote(image)} >/dev/null && k3s crictl inspecti -o json ${shellQuote(image)}`,
        ]),
        // Le socket de containerd n'est ouvert qu'à root — comme pour l'import
        // des images construites, plus haut.
        { timeout: APPLY_TIMEOUT_MS, logOutput: false, sudo: true },
      );
      const digest = result.code === 0 ? pulledDigest(result.stdout, image) : null;
      if (digest) {
        pulled.set(service, digest);
        onLog(`   ${image} → ${digest.slice(0, 19)}…`);
      } else {
        onLog(
          `   tirage impossible (${firstLine(result.stderr) ?? `code ${result.code}`}) — ` +
            "l'image locale servira",
        );
      }
    }
    return pulled;
  }

  /**
   * Un manifest identique n'est pas un changement pour Kubernetes : si seul le
   * contenu du tag a bougé, aucun pod n'est remplacé. Ce qui tourne encore sur
   * l'ancien digest est donc redémarré — et seulement cela.
   */
  private async refreshStaleImages(
    ctx: DriverContext,
    pulled: Map<string, string>,
    onLog: LogSink,
  ): Promise<void> {
    if (pulled.size === 0) return;
    const running = await this.runningImages(ctx);
    for (const { service, digests } of running) {
      const latest = pulled.get(service);
      if (!latest || digests.length === 0 || digests.every((digest) => digest === latest)) continue;
      onLog(
        `« ${service} » tourne sur une image antérieure — redémarrage sur ${latest.slice(0, 19)}…`,
      );
      await this.stream(
        ctx,
        this.kube(ctx, `rollout restart deployment/${service}`),
        onLog,
        'rollout',
        APPLY_TIMEOUT_MS,
      );
      await this.stream(
        ctx,
        this.kube(ctx, `rollout status deployment/${service} --timeout=${ROLLOUT_TIMEOUT}`),
        onLog,
        'rollout',
        APPLY_TIMEOUT_MS,
      );
    }
  }

  /**
   * Cycle de vie d'une charge, en Kubernetes :
   *
   *   - **redémarrer** : `rollout restart` du contrôleur, puis `rollout
   *     status` — les pods sont remplacés sur le manifeste courant ;
   *   - **arrêter** : mise à zéro des répliques d'un Deployment ou d'un
   *     StatefulSet. Le nombre d'avant est noté dans une annotation, pour que
   *     « démarrer » le rende tel quel ;
   *   - **démarrer** : les répliques notées (une, à défaut), puis `rollout
   *     status`.
   *
   * Un DaemonSet tourne sur chaque nœud par construction : il ne s'arrête pas
   * sans être supprimé. Un pod sans contrôleur, lui, ne se recrée pas. Les
   * deux sont refusés plutôt que maquillés.
   */
  async controlWorkload(
    ctx: TargetContext,
    ref: WorkloadRef,
    action: WorkloadControlAction,
    onLog: LogSink,
  ): Promise<void> {
    const step = `workload.${action}`;
    const { workload, resource } = await this.findWorkload(ctx, ref, step);
    if (workload.managed && action !== 'restart') {
      throw new DriverError(managedWorkloadControlRefusal(workload), this.runtime, step);
    }
    if (SYSTEM_NAMESPACES.has(resource.namespace)) {
      throw new DriverError(
        `« ${workload.name} » vit dans le namespace système « ${resource.namespace} » : ` +
          'le panel ne pilote pas ce qui fait tourner le cluster.',
        this.runtime,
        step,
      );
    }
    const ns = `-n ${resource.namespace}`;
    const path = `${resource.kind}/${resource.name}`;

    if (action === 'restart') {
      if (resource.kind === 'pod') {
        throw new DriverError(
          `« ${workload.name} » est un pod sans contrôleur : rien ne le recréerait.`,
          this.runtime,
          step,
        );
      }
      onLog(`→ kubectl ${ns} rollout restart ${path}`);
      await this.stream(
        ctx,
        this.kubectl(`${ns} rollout restart ${path}`),
        onLog,
        step,
        APPLY_TIMEOUT_MS,
      );
      await this.stream(
        ctx,
        this.kubectl(`${ns} rollout status ${path} --timeout=${ROLLOUT_TIMEOUT}`),
        onLog,
        step,
        APPLY_TIMEOUT_MS,
      );
      onLog('✓ pods remplacés');
      return;
    }

    if (resource.kind !== 'deployment' && resource.kind !== 'statefulset') {
      throw new DriverError(
        resource.kind === 'daemonset'
          ? `« ${workload.name} » est un DaemonSet : il tourne sur chaque nœud et ne s'arrête pas sans être supprimé.`
          : `« ${workload.name} » est un pod sans contrôleur : l'arrêter le supprimerait pour de bon.`,
        this.runtime,
        step,
      );
    }

    const read = await exec(
      ctx.sshSession,
      this.kubectl(
        `${ns} get ${path} -o jsonpath='{.spec.replicas}{" "}{.metadata.annotations.pupitre\\.io/replicas-before-stop}'`,
      ),
      { timeout: SHORT_TIMEOUT_MS, logOutput: false },
    );
    const [currentRaw = '', savedRaw = ''] = read.stdout.trim().split(/\s+/);
    const current = Number.parseInt(currentRaw, 10) || 0;

    if (action === 'stop') {
      if (current === 0) {
        onLog('déjà arrêtée — zéro réplique');
        return;
      }
      onLog(`→ kubectl ${ns} scale ${path} --replicas=0 (${current} avant)`);
      await this.stream(
        ctx,
        this.kubectl(
          `${ns} annotate ${path} pupitre.io/replicas-before-stop=${current} --overwrite`,
        ),
        onLog,
        step,
        SHORT_TIMEOUT_MS,
      );
      await this.stream(
        ctx,
        this.kubectl(`${ns} scale ${path} --replicas=0`),
        onLog,
        step,
        SHORT_TIMEOUT_MS,
      );
      onLog('✓ arrêtée — ses volumes et son service restent en place');
      return;
    }

    if (current > 0) {
      onLog(`déjà en marche — ${current} réplique(s)`);
      return;
    }
    const replicas = Math.max(1, Number.parseInt(savedRaw, 10) || 1);
    onLog(`→ kubectl ${ns} scale ${path} --replicas=${replicas}`);
    await this.stream(
      ctx,
      this.kubectl(`${ns} scale ${path} --replicas=${replicas}`),
      onLog,
      step,
      SHORT_TIMEOUT_MS,
    );
    await this.stream(
      ctx,
      this.kubectl(`${ns} annotate ${path} pupitre.io/replicas-before-stop-`),
      onLog,
      step,
      SHORT_TIMEOUT_MS,
      false,
    );
    await this.stream(
      ctx,
      this.kubectl(`${ns} rollout status ${path} --timeout=${ROLLOUT_TIMEOUT}`),
      onLog,
      step,
      APPLY_TIMEOUT_MS,
    );
    onLog('✓ démarrée');
  }

  /**
   * Le journal d'une charge, **tous ses pods** : `kubectl logs deployment/x`
   * n'en lirait qu'un (« Found 2 pods, using pod/… »). Pour un contrôleur, on
   * passe donc par son sélecteur, puis on remet les lignes dans l'ordre du
   * temps — chaque pod arrive d'un bloc, et l'opérateur lit une chronologie.
   */
  async workloadLogs(
    ctx: TargetContext,
    ref: WorkloadRef,
    tail: number,
    onLine: LogSink,
  ): Promise<void> {
    const { resource } = await this.findWorkload(ctx, ref, 'workload.logs');
    const lines = Math.max(1, Math.floor(tail));
    const ns = `-n ${resource.namespace}`;

    let source = `${resource.kind}/${resource.name}`;
    if (resource.kind !== 'pod') {
      const read = await exec(
        ctx.sshSession,
        this.kubectl(`${ns} get ${source} -o jsonpath='{.spec.selector.matchLabels}'`),
        { timeout: SHORT_TIMEOUT_MS, logOutput: false },
      );
      const selector = labelSelector(read.stdout);
      if (!selector) {
        throw new DriverError(
          `« ${resource.name} » n'a pas de sélecteur lisible : impossible de trouver ses pods.`,
          this.runtime,
          'workload.logs',
        );
      }
      source = `-l ${shellQuote(selector)} --max-log-requests=20`;
    }

    const collected: string[] = [];
    await this.stream(
      ctx,
      this.kubectl(
        `${ns} logs ${source} --all-containers=true --prefix --timestamps --tail=${lines}`,
      ),
      (line) => collected.push(line),
      'workload.logs',
      SHORT_TIMEOUT_MS,
    );
    for (const line of chronological(collected).slice(-lines)) onLine(line);
  }

  /**
   * `kubectl exec` sur la ressource : pour un contrôleur, kubectl choisit un
   * de ses pods. Pas dans les namespaces système, pas plus qu'on n'y supprime.
   */
  async execInWorkload(
    ctx: TargetContext,
    ref: WorkloadRef,
    command: string,
    onLine: LogSink,
    options: WorkloadExecOptions,
  ): Promise<WorkloadExecResult> {
    const { workload, resource } = await this.findWorkload(ctx, ref, 'workload.exec');
    if (SYSTEM_NAMESPACES.has(resource.namespace)) {
      throw new DriverError(
        `« ${workload.name} » vit dans le namespace système « ${resource.namespace} » : ` +
          'le panel n’y exécute rien.',
        this.runtime,
        'workload.exec',
      );
    }
    if (!workload.exec) {
      throw new DriverError(
        `« ${workload.name} » n'a aucun pod prêt : une commande ne s'exécute que dans une charge en marche.`,
        this.runtime,
        'workload.exec',
      );
    }
    return runBoundedExec(
      ctx.sshSession,
      this.kubectl(
        `-n ${resource.namespace} exec ${resource.kind}/${resource.name} -- sh -c ${quoteForShell(command)} 2>&1`,
      ),
      onLine,
      options,
    );
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
/** De quoi lancer `tar`, rien d'autre — l'image des opérations de sauvegarde. */
const BACKUP_HELPER_IMAGE = 'busybox:1.37';

/** Vide le volume — fichiers cachés compris —, puis y extrait l'archive lue sur l'entrée. */
const CLEAR_AND_EXTRACT = 'cd /data && rm -rf -- * .[!.]* ..?* 2>/dev/null; tar xzf - -C /data';

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
    containerStatuses?: Array<{
      name?: string;
      ready?: boolean;
      image?: string;
      imageID?: string;
      restartCount?: number;
    }> | null;
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
  const managed = isManaged(meta);
  const system = SYSTEM_NAMESPACES.has(meta.namespace);

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
    managed,
    managedApp: managedApp(meta),
    controls: system ? [] : controllerControls(kind, state, managed),
    exec: !system && ready,
  };
}

/**
 * Ce qu'un contrôleur accepte : tous redémarrent ; seuls un Deployment et un
 * StatefulSet s'arrêtent (zéro réplique) et redémarrent — un DaemonSet tourne
 * sur chaque nœud par construction. Une charge du panel ne fait que redémarrer.
 */
function controllerControls(
  kind: string,
  state: ServiceState,
  managed: boolean,
): WorkloadControlAction[] {
  // Arrêtée, une charge du panel attend que son application redémarre :
  // un `rollout restart` à zéro réplique ne ferait rien.
  if (managed) return state === 'exited' ? [] : ['restart'];
  if (kind === 'daemonset') return ['restart'];
  return state === 'exited' ? ['start'] : ['stop', 'restart'];
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
    // Un pod sans contrôleur ne se redémarre ni ne s'arrête : rien ne le
    // recréerait. On peut encore lire son journal et y exécuter une commande.
    controls: [],
    exec: !SYSTEM_NAMESPACES.has(meta.namespace) && ready,
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

/**
 * `{"app":"web","tier":"front"}` → `app=web,tier=front`. Rien de lisible →
 * `null` : mieux vaut refuser que lire le journal de tout le namespace.
 */
export function labelSelector(matchLabels: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(matchLabels.trim() || 'null');
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const pairs = Object.entries(parsed as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  if (pairs.length === 0) return null;
  return pairs.map(([key, value]) => `${key}=${value}`).join(',');
}

const STAMP = /^(?:\[[^\]]*\] )?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z /;

/**
 * Remet dans l'ordre du temps des lignes `[pod/x/c] 2026-…Z texte`.
 *
 * Les horodatages sont en UTC, au format RFC 3339 « nano » — qui **retire**
 * les zéros de fin : `33.1Z` et `33.123456789Z` ne se comparent pas comme des
 * chaînes. La fraction est donc complétée à neuf chiffres. Tri stable : une
 * ligne sans horodatage (une continuation) reste derrière celle qui la précède.
 */
export function chronological(lines: string[]): string[] {
  let last = '';
  return lines
    .map((line, index) => {
      const match = STAMP.exec(line);
      if (match) last = `${match[1]}.${(match[2] ?? '').padEnd(9, '0').slice(0, 9)}`;
      return { line, index, key: last };
    })
    .sort((a, b) => (a.key === b.key ? a.index - b.index : a.key < b.key ? -1 : 1))
    .map((entry) => entry.line);
}

/**
 * Les digests des pods d'une application, par service. Le service est le label
 * `app.kubernetes.io/name` posé par le rendu ; `imageID` est la forme
 * `docker.io/library/nginx@sha256:…` de containerd.
 */
export function parsePodImages(json: string): RunningImage[] {
  const byService = new Map<string, Set<string>>();
  for (const item of kubeItems(json)) {
    const service = item.metadata?.labels?.['app.kubernetes.io/name'];
    if (!service) continue;
    const digests = byService.get(service) ?? new Set<string>();
    for (const container of item.status?.containerStatuses ?? []) {
      if (container.name && container.name !== service) continue;
      const digest = container.imageID ? digestOf(container.imageID) : null;
      if (digest) digests.add(digest);
    }
    byService.set(service, digests);
  }
  return [...byService].map(([service, digests]) => ({ service, digests: [...digests] }));
}

/**
 * Le digest d'une image tirée, lu dans `crictl inspecti -o json` : parmi ses
 * `repoDigests`, celui du dépôt demandé (une même image peut être connue sous
 * plusieurs noms).
 */
export function pulledDigest(json: string, image: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const repoDigests = (parsed as { status?: { repoDigests?: unknown } }).status?.repoDigests;
  if (!Array.isArray(repoDigests)) return null;
  const ref = parseImageReference(image);
  const wanted = ref
    ? `${ref.registry === 'registry-1.docker.io' ? 'docker.io' : ref.registry}/${ref.repository}@`
    : null;
  const candidates = repoDigests.filter((value): value is string => typeof value === 'string');
  const match = (wanted && candidates.find((value) => value.startsWith(wanted))) ?? candidates[0];
  return match ? digestOf(match) : null;
}
