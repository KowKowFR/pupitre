import type { PortAllocator } from '../ports.js';
import type { AppStatus } from '../supervision.js';
import type { AppSpec } from '../spec/index.js';
import type { SshSession } from '../ssh/client.js';
import type { Workload, WorkloadRef } from '../workloads.js';

/**
 * Contrat que doit remplir un runtime pour être déployable par le panel.
 *
 * Règle structurante : le driver **n'importe rien** de `packages/db`, ni de
 * `apps/web`, ni de Redis. Il reçoit tout par son contexte, il exécute, et il
 * émet des lignes. C'est l'appelant qui décide quoi en faire — les publier sur
 * Redis, les écrire en base, ou les jeter.
 *
 * Ajouter un runtime doit se faire en ajoutant une classe ici, sans modifier
 * une seule ligne ailleurs.
 */

export type RuntimeKind = 'docker' | 'k3s';

/** Machine distante, telle que le driver a besoin de la connaître. */
export type DriverTarget = {
  id: string;
  name: string;
  host: string;
  /** Chemin racine où le driver dépose ses artefacts sur la cible. */
  rootPath: string;
};

/** Déploiement en cours, tel que le driver a besoin de le connaître. */
export type DriverDeployment = {
  id: string;
  /** Version applicative déployée, reprise de l'AppSpec. */
  version: string;
  /** Numéro incrémental, sert à nommer les répertoires sur la cible. */
  sequence: number;
};

export type { PortAllocator } from '../ports.js';

/** Valeurs des secrets déclarés par l'AppSpec, résolues par l'appelant. */
export type SecretResolver = (names: readonly string[]) => Promise<Record<string, string>>;

/** Fichier rendu, prêt à être déposé sur la cible. */
export type RenderedFile = {
  /** Chemin relatif à la racine du bundle. */
  path: string;
  content: string;
  /** Mode POSIX, ex. `0o644`. */
  mode?: number;
};

/**
 * Contexte au niveau de la **machine**, pas d'un déploiement.
 *
 * Il existe parce que `listWorkloads`, `removeWorkload` et `updateWorkload`
 * n'ont ni AppSpec, ni slug, ni numéro de version à offrir : elles regardent la
 * cible entière, y compris ce que le panel n'a jamais déployé. L'autre voie —
 * rendre `spec`, `deployment`, `appSlug` et `applicationId` optionnels dans
 * `DriverContext` — aurait produit un type dont la moitié des champs est
 * `undefined` la moitié du temps : le compilateur aurait cessé de garantir
 * qu'un `deploy()` reçoit bien une spec, et chaque driver aurait dû rouvrir la
 * question à la main. Un type qui ment sur ce qu'il contient ne protège plus
 * personne.
 *
 * `DriverContext` en est une extension : tout ce qui accepte un contexte de
 * déploiement accepte déjà un contexte de cible, et aucun appel existant ne
 * change.
 */
export type TargetContext = {
  target: DriverTarget;
  sshSession: SshSession;
};

export type DriverContext = TargetContext & {
  spec: AppSpec;
  deployment: DriverDeployment;
  /** Identifiant stable de l'application. Sert de namespace : `app-{slug}`. */
  appSlug: string;
  /** Identifiant base de l'application, pour les réservations de ports. */
  applicationId: string;
  /** Déploiement vers lequel `rollback()` ramène. */
  previousDeployment?: DriverDeployment;
  portAllocator?: PortAllocator;
  /**
   * Plage de ports publiables sur cette cible. Défaut : 30000-32767.
   * Une cible derrière un pare-feu n'en a souvent qu'une partie d'ouverte.
   */
  portRange?: { min: number; max: number };
  resolveSecrets?: SecretResolver;
  /**
   * Fichiers supplémentaires à déposer avec les artefacts rendus — typiquement
   * le code source, quand un service se construit depuis un Dockerfile.
   * Le driver ne sait pas d'où ils viennent : ni git, ni registry, ni archive.
   * C'est le pipeline qui les fournit.
   */
  additionalFiles?: RenderedFile[];
};

export type PreflightResult = {
  ok: boolean;
  /** Version du moteur d'exécution sur la cible. */
  runtimeVersion: string | null;
  /** Espace disponible sur le point de montage racine du driver, en Mio. */
  availableDiskMi: number | null;
  checks: Array<{
    key: string;
    label: string;
    ok: boolean;
    detail: string | null;
  }>;
};

export type RenderedArtifacts = {
  /** Nom du projet / namespace : `app-{slug}`. */
  projectName: string;
  files: RenderedFile[];
  /** Port publié sur la cible, ou `null` si l'exposition passe par un Ingress. */
  publishedPort: number | null;
};

export type DeployResult = {
  ok: boolean;
  /** URL par laquelle l'application répond, si le driver peut la déterminer. */
  url: string | null;
  publishedPort: number | null;
  /** Répertoire de la version déployée sur la cible. */
  releasePath: string;
  /** Images construites ou tirées, pour l'historique et les scanners. */
  images: string[];
};

/**
 * Issue d'une sonde de santé. Trois cas, pas deux :
 *   healthy      le service répond, et il répond bien ;
 *   unhealthy    il répond, mais avec un code hors 2xx/3xx — il tourne, il est cassé ;
 *   unreachable  rien au bout : conteneur absent, port fermé, pod non prêt.
 *
 * La distinction change le diagnostic à produire, et elle est perdue dès qu'on
 * la réduit à un booléen.
 */
export type HealthOutcome = 'healthy' | 'unhealthy' | 'unreachable';

export type HealthResult = {
  healthy: boolean;
  outcome: HealthOutcome;
  attempts: number;
  /** Dernier code HTTP observé, si la sonde est HTTP. */
  statusCode: number | null;
  detail: string | null;
  /**
   * Diagnostic capturé **sur la cible** au moment de l'échec : état des
   * conteneurs ou des pods, et leurs derniers logs. Capturé avant de rendre la
   * main, parce qu'un rollback qui suit effacerait la scène.
   */
  diagnostics: string | null;
};

/** Le driver émet des lignes, il ne sait pas où elles vont. */
export type LogSink = (line: string) => void;

export interface DeploymentDriver {
  readonly runtime: RuntimeKind;

  /**
   * Nom sous lequel ce runtime regroupe l'application sur la machine : projet
   * Compose côté Docker, namespace côté K3s. Convention `app-{slug}`.
   *
   * Seule méthode de l'interface qui ne demande **ni contexte, ni session SSH** :
   * c'est exactement ce qu'il faut quand la cible est injoignable et qu'on doit
   * quand même écrire, dans le journal d'activité, ce qu'il restera à nettoyer
   * à la main. Sur l'interface plutôt que chez l'appelant, parce que ce nom est
   * une décision du driver — le déduire ailleurs ferait fuir le vocabulaire d'un
   * runtime hors de sa classe.
   */
  workspaceName(appSlug: string): string;

  /**
   * Les commandes à passer **sur la machine** pour démonter cette application à
   * la main, quand le panel n'a plus les moyens de le faire lui-même — cible
   * injoignable, enregistrement effacé de force.
   *
   * Sur l'interface pour la même raison que `workspaceName()` : `docker compose
   * down` et `kubectl delete namespace` sont du vocabulaire de runtime, et la
   * règle est qu'il ne sort pas d'une classe de driver. Le jour où la
   * destruction apprend un geste de plus, il s'ajoute ici aussi, au même
   * endroit. Pure, sans session : c'est justement quand la session est
   * impossible qu'on en a besoin.
   */
  manualCleanup(appSlug: string, rootPath: string): string[];

  /** La cible est-elle capable d'accueillir ce déploiement ? */
  preflight(ctx: DriverContext): Promise<PreflightResult>;

  /**
   * Réserve le port public. Retourne `null` quand le runtime n'expose pas par
   * port — le K3sDriver du jalon 5 passe par un Ingress.
   *
   * Le `onLog` est optionnel : la réservation est silencieuse en temps normal,
   * mais elle a des choses à dire quand un port réservé se révèle occupé sur la
   * cible par un service étranger au panel.
   */
  allocatePort(ctx: DriverContext, onLog?: LogSink): Promise<number | null>;

  /** Traduit l'AppSpec en artefacts propres au runtime. Aucun effet de bord. */
  render(ctx: DriverContext): Promise<RenderedArtifacts>;

  /**
   * Dépose les artefacts sur la cible et vérifie que tout est en place.
   * Séparé de `deploy()` parce que le pipeline en fait une étape observable.
   */
  upload(ctx: DriverContext, artifacts: RenderedArtifacts, onLog: LogSink): Promise<void>;

  /**
   * Construit les images à bâtir. Retourne `null` quand il n'y a rien à
   * construire — l'étape correspondante sera marquée `skipped`. C'est le driver
   * qui décide, pas l'appelant.
   */
  build(ctx: DriverContext, onLog: LogSink): Promise<string[] | null>;

  /**
   * Images que ce déploiement va exécuter, telles que **ce runtime** les nomme.
   *
   * Le nommage d'une image construite est une décision du driver (préfixe de
   * projet en Compose, préfixe de namespace en K3s) : l'appelant n'a aucun
   * moyen de la deviner. Les scanners du jalon 6 ont besoin de cette liste
   * avant `deploy()`, alors qu'aucun conteneur n'a encore démarré.
   */
  images(ctx: DriverContext): Promise<string[]>;

  /** Démarre les services. Suppose `upload()` et, le cas échéant, `build()` faits. */
  deploy(ctx: DriverContext, onLog: LogSink): Promise<DeployResult>;

  healthcheck(ctx: DriverContext): Promise<HealthResult>;

  /** Redéploie la version précédente. Exige `ctx.previousDeployment`. */
  rollback(ctx: DriverContext, onLog: LogSink): Promise<void>;

  /** Détruit le déploiement et libère ses ressources. */
  destroy(ctx: DriverContext, onLog: LogSink): Promise<void>;

  /**
   * Supprime les répertoires de version au-delà des `keep` plus récents, en
   * préservant toujours la version courante. Retourne ce qui a été supprimé.
   *
   * Sur l'interface, et non chez l'appelant : c'est le driver qui sait où il
   * dépose ses releases. La tâche planifiée `cleanup:versions` du jalon 8
   * l'appelle sans jamais nommer un chemin, ni savoir sur quel runtime elle
   * tourne.
   */
  pruneReleases(ctx: DriverContext, onLog: LogSink, keep?: number): Promise<string[]>;

  /** Suit les logs applicatifs, ligne par ligne, jusqu'à interruption. */
  logs(ctx: DriverContext, onLine: LogSink): Promise<void>;

  /**
   * État courant des services, tel que le runtime le rapporte.
   * Lecture seule et rapide : sert à la supervision, pas au pipeline.
   */
  status(ctx: DriverContext): Promise<AppStatus>;

  /**
   * Redémarre l'application sans la redéployer : mêmes images, mêmes volumes,
   * même port. Ce n'est pas un rollback, ce n'est pas un déploiement.
   */
  restart(ctx: DriverContext, onLog: LogSink): Promise<void>;

  /**
   * Arrête l'application sans rien démonter.
   *
   * ── Le contrat, identique sur les deux runtimes ─────────────────────────────
   * Ce qui s'arrête : les processus, et eux seuls.
   * Ce qui reste : les volumes et leurs données, la réservation de port en
   * base, le répertoire de release sur la cible, l'entrée de proxy ou
   * l'Ingress, et l'enregistrement du déploiement. `start()` doit pouvoir
   * remettre en marche **exactement** ce que `deploy()` avait posé — sans
   * nouveau rendu, sans reconstruction, sans changement de version.
   *
   * Idempotent : arrêter une application déjà arrêtée réussit sans rien faire.
   * C'est ce qui rend le geste rejouable après une coupure de session, et ce
   * qui évite d'avoir à interroger l'état avant d'agir.
   *
   * ── Une divergence observable, et elle est assumée ──────────────────────────
   * Ce que voit un visiteur pendant l'arrêt n'est pas le même des deux côtés :
   * en Compose le port hôte se libère avec le conteneur — la connexion est
   * refusée ; en Kubernetes le Service et l'Ingress survivent aux pods — le
   * contrôleur d'ingress répond 503. Aucune des deux ne peut être imitée par
   * l'autre sans détruire ce que le contrat promet de garder (l'entrée de proxy
   * d'un côté, la réservation de port de l'autre). On la documente ici plutôt
   * que de la maquiller.
   *
   * Obligatoire, et non optionnelle comme `openFirewall()` : les deux runtimes
   * ont une traduction honnête du geste. Une méthode optionnelle dit « ce
   * runtime n'a pas cette capacité » — ce n'est pas le cas ici, et le laisser
   * croire obligerait l'appelant à prévoir un cas qui n'existe pas.
   */
  stop(ctx: DriverContext, onLog: LogSink): Promise<void>;

  /**
   * Remet en marche ce que `stop()` a arrêté, dans l'état où `deploy()` l'avait
   * laissé — mêmes images, mêmes volumes, même port, même nombre de répliques
   * que l'AppSpec en demande.
   *
   * Idempotent lui aussi : démarrer une application déjà en marche réussit.
   * Rend la main quand les services sont **prêts**, pas quand l'ordre est
   * passé : c'est ce qui permet à l'appelant d'enchaîner sur une sonde de santé
   * qui veut dire quelque chose.
   */
  start(ctx: DriverContext, onLog: LogSink): Promise<void>;

  // ─── charges de la cible ───────────────────────────────────────────────────
  //
  // Ces trois-là ne parlent pas d'un déploiement mais de la **machine** : elles
  // voient tout ce qui tourne, que le panel l'ait déployé ou non. D'où le
  // `TargetContext` plutôt que le `DriverContext`.

  /**
   * Tout ce qui tourne sur la cible pour ce runtime, panel compris.
   *
   * Chaque charge se dit elle-même `managed` ou non : c'est le driver qui sait
   * reconnaître sa propre signature sur la machine, et personne d'autre.
   * Lecture seule, et courte — une commande, pas une session.
   */
  listWorkloads(ctx: TargetContext): Promise<Workload[]>;

  /**
   * Supprime une charge et ce qu'elle emporte avec elle.
   *
   * Doit refuser une charge `managed` : le panel tient déjà son cycle de vie
   * ailleurs, et l'effacer par ce chemin laisserait la base persuadée qu'elle
   * tourne. Le refus est un `DriverError`, pas un silence.
   */
  removeWorkload(ctx: TargetContext, ref: WorkloadRef, onLog: LogSink): Promise<void>;

  /**
   * Récupère l'image la plus récente et recrée la charge avec la même
   * configuration. Ce que « la même configuration » veut dire est propre à
   * chaque runtime, et c'est écrit dans chaque implémentation.
   *
   * Comme `removeWorkload`, refuse une charge `managed` : mettre à jour une
   * application du panel, c'est la redéployer, pas la recréer dans son dos.
   */
  updateWorkload(ctx: TargetContext, ref: WorkloadRef, onLog: LogSink): Promise<void>;

  /**
   * Ouvre le port sur le pare-feu de la cible.
   *
   * **Optionnelle à dessein.** Un runtime qui n'expose aucun port hôte n'a rien
   * à ouvrir : il n'implémente simplement pas la méthode, et l'appelant qui ne
   * la trouve pas passe son chemin. C'est une question de capacité du driver,
   * jamais un `if (runtime === ...)` chez l'appelant.
   */
  openFirewall?(ctx: DriverContext, port: number, onLog?: LogSink): Promise<void>;

  /** Referme le port. Pendant de `openFirewall`, même règle d'optionalité. */
  closeFirewall?(ctx: DriverContext, port: number, onLog?: LogSink): Promise<void>;
}

/** Échec imputable au driver, avec le contexte utile au diagnostic. */
export class DriverError extends Error {
  constructor(
    message: string,
    readonly runtime: RuntimeKind,
    readonly step: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'DriverError';
  }
}
