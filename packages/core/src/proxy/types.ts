import type { LogSink, TargetContext } from '../drivers/types.js';
import type { UiLanguage } from '../i18n.js';
import type {
  AcmeServer,
  AcmeSettings,
  ProxyKind,
  ProxyUpstream,
  RouteCertificate,
  RouteInput,
} from './model.js';

/**
 * The contract of a reverse proxy the panel can drive.
 *
 * The same rule as for drivers: adding a proxy means adding a class that
 * fulfills this contract, without touching a line elsewhere. The provider reads
 * neither the database nor Redis; it receives its configuration and a session
 * to the machine it runs on, it acts, it emits lines.
 *
 * ── Declarative ─────────────────────────────────────────────────────────────
 * `apply()` receives **all** of an application's routes and makes sure the
 * proxy has no others. Adding, removing, changing a domain is the same call; no
 * empty list leaves leftovers. And a proxy never touches what it did not set
 * up: each object it creates carries Pupitre's mark and the application's name.
 */

/** The machine hosting the proxy, with a session open to it. */
export type ProxyHostContext = TargetContext;

/** A connection in service: its machine and its configuration, already validated. */
export type ProxyContext = ProxyHostContext & { config: unknown };

export type ProxyRoute = Required<RouteInput>;

/** Everything a proxy must route for an application. */
export type ProxyRouteSet = {
  appSlug: string;
  /**
   * What distinguishes this machine when the proxy serves several: the same
   * application can run on two of them, each with its domains, without one
   * erasing the other's routes. Absent: the proxy's machine.
   */
  scope?: string;
  /** Empty: the application must no longer have anything on this proxy. */
  routes: ProxyRoute[];
  /** How to reach it. `null` only when `routes` is empty. */
  upstream: ProxyUpstream | null;
};

export type ProxyCheck = {
  ok: boolean;
  checks: Array<{ key: string; label: string; ok: boolean; detail: string | null }>;
};

/** An installation found on the machine, ready to become a connection. */
export type ProxyDetection = {
  kind: ProxyKind;
  /** The derived configuration — to be reviewed and confirmed by the user. */
  config: unknown;
  /** What was found, in one sentence. */
  summary: string;
  /** What is missing or surprising: no ACME resolver, bridge network… */
  warnings: string[];
};

/** A way to install this proxy on this machine, and whether it is possible. */
export type ProxyInstallOption = {
  kind: ProxyKind;
  /** Unique for a kind: the installation request names it together with the kind. */
  key: string;
  /** What is installed, in a few words: "Traefik in a container". */
  title: string;
  /** The certificate authorities this installation can query. */
  acmeServers: AcmeServer[];
  available: boolean;
  /** Why it is not, or what it will do. */
  detail: string;
};

export type ProxyInstallRequest = { option: string; acme: AcmeSettings };

/**
 * What a route gives, seen from the proxy's machine: the request goes through
 * the proxy, the name forced to the loopback — the machine has no reason to
 * know the domain's public DNS.
 */
export type RouteProbe = {
  ok: boolean;
  /** HTTP code on port 80, `null` if not probed. */
  http: number | null;
  /** HTTP code on port 443, `null` if the route is not HTTPS. */
  https: number | null;
  detail: string;
  certificate: RouteCertificate;
};

export interface ProxyProvider {
  readonly kind: ProxyKind;

  /** Validates a configuration coming from the database or a form. */
  parseConfig(config: unknown): unknown;

  /**
   * Where to publish the port of an application this proxy serves **from its own
   * machine**: the loopback when it reaches it that way — the port then no longer
   * has to be open to the world. `null`: it reaches it otherwise, the port stays
   * published on every interface.
   */
  publishAddress(config: unknown): string | null;

  /** This proxy's installations present on the machine. */
  detect(ctx: ProxyHostContext, onLog: LogSink): Promise<ProxyDetection[]>;

  /** What Pupitre can install here — and why not, otherwise. */
  installOptions(ctx: ProxyHostContext): Promise<ProxyInstallOption[]>;

  /** Installs (or configures) the proxy, and returns the connection's configuration. */
  install(ctx: ProxyHostContext, request: ProxyInstallRequest, onLog: LogSink): Promise<unknown>;

  /** Undoes what `install()` set up. No effect on a proxy found, not installed. */
  uninstall(ctx: ProxyContext, onLog: LogSink): Promise<void>;

  /** "Test": does the proxy answer, and does it really set up what it is given? */
  check(ctx: ProxyContext, onLog: LogSink): Promise<ProxyCheck>;

  /** Makes the proxy match all of an application's routes. */
  apply(ctx: ProxyContext, set: ProxyRouteSet, onLog: LogSink): Promise<void>;

  /** Queries a route through the proxy. `path`: the service's health path. */
  probe(ctx: ProxyContext, route: ProxyRoute, path: string): Promise<RouteProbe>;
}

// ─── a proxy outside the targets ─────────────────────────────────────────────

/**
 * A connection to a **remote** proxy (`placement: remote`): its configuration
 * and its secrets, decrypted by the worker. No SSH session — Pupitre does not
 * drive its machine, it talks to its API.
 */
export type RemoteProxyContext = {
  config: unknown;
  secrets: Readonly<Record<string, string>>;
  /** The instance's language, like `TargetContext.language`. */
  language: UiLanguage;
};

/**
 * What a request gave through the proxy, in curl's vocabulary — the one
 * `checkReach()` can read: `0` an answer (its body in `body`), `7` a refused
 * connection, `28` nothing in time.
 */
export type ReachAttempt = { curlCode: number; body: string };

/**
 * The contract of a remote proxy. The same rules as `ProxyProvider` —
 * declarative, only touches what it set up, reads neither the database nor
 * Redis —, without what assumes its machine: no detection, no installation. You
 * connect to it.
 */
export interface RemoteProxyProvider {
  readonly kind: ProxyKind;

  parseConfig(config: unknown): unknown;

  /** "Test": does the API answer, does the account get in, does it have the rights? */
  check(ctx: RemoteProxyContext, onLog: LogSink): Promise<ProxyCheck>;

  /** Makes the proxy match all of an application's routes. */
  apply(ctx: RemoteProxyContext, set: ProxyRouteSet, onLog: LogSink): Promise<void>;

  /**
   * Queries a route through the proxy, **from the panel**: through the address
   * where it receives visitors, with the requested name (`Host` header, SNI).
   */
  probe(ctx: RemoteProxyContext, route: ProxyRoute, path: string): Promise<RouteProbe>;

  /**
   * A link test: a `GET /{token}` request to `address:port`, which the proxy
   * relays — it is the proxy that opens the connection, as it will for visitors.
   * Nothing remains on the proxy afterwards.
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
