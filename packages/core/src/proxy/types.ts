import type { LogSink, TargetContext } from '../drivers/types.js';
import type {
  AcmeServer,
  AcmeSettings,
  ProxyKind,
  ProxyUpstream,
  RouteCertificate,
  RouteInput,
} from './model.js';

/**
 * Contrat d'un reverse proxy pilotable par le panel.
 *
 * Même règle que pour les drivers : ajouter un proxy, c'est ajouter une classe
 * qui remplit ce contrat, sans toucher une ligne ailleurs. Le provider ne lit
 * ni la base ni Redis ; il reçoit sa configuration et une session vers la
 * machine où il tourne, il agit, il émet des lignes.
 *
 * ── Déclaratif ──────────────────────────────────────────────────────────────
 * `apply()` reçoit **l'ensemble** des routes d'une application et fait en
 * sorte que le proxy n'en ait pas d'autres. Ajouter, retirer, modifier un
 * domaine, c'est le même appel ; aucune liste vide ne laisse de reste. Et un
 * proxy ne touche jamais à ce qu'il n'a pas posé : chaque objet qu'il crée
 * porte la marque de Pupitre et le nom de l'application.
 */

/** La machine qui héberge le proxy, avec une session ouverte vers elle. */
export type ProxyHostContext = TargetContext;

/** Une connexion en service : sa machine et sa configuration, déjà validée. */
export type ProxyContext = ProxyHostContext & { config: unknown };

export type ProxyRoute = Required<RouteInput>;

/** Tout ce qu'un proxy doit router pour une application. */
export type ProxyRouteSet = {
  appSlug: string;
  /**
   * Ce qui distingue cette machine quand le proxy en sert plusieurs : la même
   * application peut tourner sur deux d'entre elles, chacune avec ses domaines,
   * sans que l'une n'efface les routes de l'autre. Absent : la machine du proxy.
   */
  scope?: string;
  /** Vide : l'application ne doit plus rien avoir sur ce proxy. */
  routes: ProxyRoute[];
  /** Par où la joindre. `null` seulement quand `routes` est vide. */
  upstream: ProxyUpstream | null;
};

export type ProxyCheck = {
  ok: boolean;
  checks: Array<{ key: string; label: string; ok: boolean; detail: string | null }>;
};

/** Une installation trouvée sur la machine, prête à devenir une connexion. */
export type ProxyDetection = {
  kind: ProxyKind;
  /** La configuration déduite — à relire et confirmer par l'utilisateur. */
  config: unknown;
  /** Ce qui a été trouvé, en une phrase. */
  summary: string;
  /** Ce qui manque ou surprend : pas de résolveur ACME, réseau bridge… */
  warnings: string[];
};

/** Une façon d'installer ce proxy sur cette machine, et si elle est possible. */
export type ProxyInstallOption = {
  kind: ProxyKind;
  /** Unique pour un genre : la requête d'installation la nomme avec lui. */
  key: string;
  /** Ce qu'on installe, en quelques mots : « Traefik en conteneur ». */
  title: string;
  /** Les autorités de certification que cette installation sait interroger. */
  acmeServers: AcmeServer[];
  available: boolean;
  /** Pourquoi elle ne l'est pas, ou ce qu'elle fera. */
  detail: string;
};

export type ProxyInstallRequest = { option: string; acme: AcmeSettings };

/**
 * Ce qu'une route donne, vue depuis la machine du proxy : la requête passe par
 * le proxy, nom forcé vers la boucle locale — la machine n'a aucune raison de
 * connaître le DNS public du domaine.
 */
export type RouteProbe = {
  ok: boolean;
  /** Code HTTP sur le port 80, `null` si non sondé. */
  http: number | null;
  /** Code HTTP sur le port 443, `null` si la route n'est pas en HTTPS. */
  https: number | null;
  detail: string;
  certificate: RouteCertificate;
};

export interface ProxyProvider {
  readonly kind: ProxyKind;

  /** Valide une configuration venue de la base ou d'un formulaire. */
  parseConfig(config: unknown): unknown;

  /**
   * Où publier le port d'une application que ce proxy sert **depuis sa propre
   * machine** : la boucle locale quand il la joint par là — le port n'a alors
   * plus à être ouvert au monde. `null` : il la joint autrement, le port reste
   * publié sur toutes les interfaces.
   */
  publishAddress(config: unknown): string | null;

  /** Les installations de ce proxy présentes sur la machine. */
  detect(ctx: ProxyHostContext, onLog: LogSink): Promise<ProxyDetection[]>;

  /** Ce que Pupitre peut installer ici — et pourquoi pas, sinon. */
  installOptions(ctx: ProxyHostContext): Promise<ProxyInstallOption[]>;

  /** Installe (ou configure) le proxy, et rend la configuration de la connexion. */
  install(ctx: ProxyHostContext, request: ProxyInstallRequest, onLog: LogSink): Promise<unknown>;

  /** Défait ce que `install()` a posé. Sans effet sur un proxy trouvé, non installé. */
  uninstall(ctx: ProxyContext, onLog: LogSink): Promise<void>;

  /** « Tester » : le proxy répond-il, et pose-t-il bien ce qu'on lui confie ? */
  check(ctx: ProxyContext, onLog: LogSink): Promise<ProxyCheck>;

  /** Fait correspondre le proxy à l'ensemble des routes d'une application. */
  apply(ctx: ProxyContext, set: ProxyRouteSet, onLog: LogSink): Promise<void>;

  /** Interroge une route à travers le proxy. `path` : le chemin de santé du service. */
  probe(ctx: ProxyContext, route: ProxyRoute, path: string): Promise<RouteProbe>;
}

// ─── un proxy hors des cibles ────────────────────────────────────────────────

/**
 * Une connexion à un proxy **distant** (`placement: remote`) : sa configuration
 * et ses secrets, déchiffrés par le worker. Aucune session SSH — Pupitre ne
 * pilote pas sa machine, il parle à son API.
 */
export type RemoteProxyContext = {
  config: unknown;
  secrets: Readonly<Record<string, string>>;
};

/**
 * Ce qu'une requête a donné à travers le proxy, dans le vocabulaire de curl —
 * celui que `checkReach()` sait lire : `0` une réponse (son corps dans
 * `body`), `7` une connexion refusée, `28` rien dans le délai.
 */
export type ReachAttempt = { curlCode: number; body: string };

/**
 * Le contrat d'un proxy distant. Mêmes règles que `ProxyProvider` — déclaratif,
 * ne touche qu'à ce qu'il a posé, ne lit ni la base ni Redis —, sans ce qui
 * suppose sa machine : ni détection, ni installation. On s'y connecte.
 */
export interface RemoteProxyProvider {
  readonly kind: ProxyKind;

  parseConfig(config: unknown): unknown;

  /** « Tester » : l'API répond-elle, le compte entre-t-il, a-t-il les droits ? */
  check(ctx: RemoteProxyContext, onLog: LogSink): Promise<ProxyCheck>;

  /** Fait correspondre le proxy à l'ensemble des routes d'une application. */
  apply(ctx: RemoteProxyContext, set: ProxyRouteSet, onLog: LogSink): Promise<void>;

  /**
   * Interroge une route à travers le proxy, **depuis le panel** : par l'adresse
   * où il reçoit les visiteurs, avec le nom demandé (en-tête `Host`, SNI).
   */
  probe(ctx: RemoteProxyContext, route: ProxyRoute, path: string): Promise<RouteProbe>;

  /**
   * Le test d'une liaison : une requête `GET /{token}` vers `address:port`, que
   * le proxy relaie — c'est lui qui ouvre la connexion, comme il le fera pour
   * les visiteurs. Rien ne reste sur le proxy après.
   */
  reach(
    ctx: RemoteProxyContext,
    request: { address: string; port: number; token: string },
    onLog: LogSink,
  ): Promise<ReachAttempt>;
}

export class ProxyError extends Error {
  constructor(
    message: string,
    readonly kind: ProxyKind,
    readonly step: string,
  ) {
    super(message);
    this.name = 'ProxyError';
  }
}
