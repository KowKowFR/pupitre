import { stringify } from 'yaml';
import type { AcmeSettings, WafMode } from '../model.js';
import type { ProxyRoute } from '../types.js';

/**
 * What Pupitre sets up in BunkerWeb — pure rendering, applied by the provider.
 *
 * ── One service per domain ──────────────────────────────────────────────────
 * BunkerWeb stores its configuration as "services", one per server name.
 * Pupitre creates one per domain, with only the settings it manages: those an
 * administrator adds by hand in BunkerWeb's interface (headers, extra limit
 * rules…) stay in place from one deployment to the next — `PATCH` only touches
 * the variables sent.
 *
 * ── The protection presets ──────────────────────────────────────────────────
 * BunkerWeb's default settings are made for a brochure site: 2 requests per
 * second **per address, all URLs together**, 10 simultaneous HTTP/1.1
 * connections per address, PUT and DELETE refused, an address banned for 24 h
 * after ten errors in a minute. Measured: twenty simultaneous requests — a page
 * and its resources — get eighteen 429s; two browsers behind the same router
 * exceed the 10 connections. A web application does not survive it; hence three
 * presets.
 */

/** Pinned version: the 1.6 series, fixes included through an explicit upgrade. */
export const BUNKERWEB_IMAGE = 'bunkerity/bunkerweb-all-in-one:1.6.15';
export const BUNKERWEB_PROJECT = 'pupitre-bunkerweb';
export const BUNKERWEB_CONTAINER = 'pupitre-bunkerweb';
export const BUNKERWEB_API_PORT = 8888;

/**
 * BunkerWeb's folder on the machine: `{driver root}/bunkerweb`. Apart from
 * Traefik's (`{root}/proxy`), which its uninstall erases.
 */
export function bunkerwebRoot(rootPath: string): string {
  return `${rootPath.replace(/\/+$/, '')}/bunkerweb`;
}

/**
 * Pupitre's probes get through BunkerWeb's whitelist with a secret header, not
 * by their address: seen from the container, they arrive from the Docker
 * gateway — like the IPv6 visitors Docker relays, which an address whitelist
 * would take away from the WAF. The secret lives on the proxy's machine, in this
 * file (`Name: value`, mode 600).
 */
export const PROBE_HEADER = 'X-Pupitre-Probe';
export function probeHeaderFile(rootPath: string): string {
  return `${bunkerwebRoot(rootPath)}/probe-header`;
}
/** Replaced on the machine by the secret, at the time of the API call. */
export const PROBE_SECRET_PLACEHOLDER = '__PUPITRE_PROBE_SECRET__';

/** A web application's methods, REST APIs included (BunkerWeb: GET|POST|HEAD). */
const WEB_METHODS = 'GET|POST|HEAD|QUERY|PUT|PATCH|DELETE|OPTIONS';

/**
 *   block   blocking ModSecurity (OWASP CRS rules); 100 requests per second per
 *           address — a page and its resources get through, a single address's
 *           flood does not; 100 simultaneous connections per address — an
 *           office behind a single address gets through; one-hour ban after
 *           thirty errors in a minute, not counting 429s (exceeding the limit
 *           does not lead to a ban);
 *   detect  the same checks, in BunkerWeb's `detect` mode: everything is logged,
 *           nothing is blocked. Without a connection limit: nginx always applies
 *           it, it cannot just log it;
 *   off     no more inspection or limit; BunkerWeb relays.
 */
export function wafPreset(mode: WafMode): Record<string, string> {
  const inspection = {
    USE_MODSECURITY: 'yes',
    USE_MODSECURITY_CRS: 'yes',
    USE_LIMIT_REQ: 'yes',
    LIMIT_REQ_URL: '/',
    LIMIT_REQ_RATE: '100r/s',
    USE_BAD_BEHAVIOR: 'yes',
    BAD_BEHAVIOR_STATUS_CODES: '400 401 403 404 405 444',
    BAD_BEHAVIOR_THRESHOLD: '30',
    BAD_BEHAVIOR_COUNT_TIME: '60',
    BAD_BEHAVIOR_BAN_TIME: '3600',
    ALLOWED_METHODS: WEB_METHODS,
  };
  if (mode === 'block') {
    return {
      SECURITY_MODE: 'block',
      MODSECURITY_SEC_RULE_ENGINE: 'On',
      ...inspection,
      USE_LIMIT_CONN: 'yes',
      LIMIT_CONN_MAX_HTTP1: '100',
    };
  }
  if (mode === 'detect') {
    return {
      SECURITY_MODE: 'detect',
      MODSECURITY_SEC_RULE_ENGINE: 'DetectionOnly',
      ...inspection,
      USE_LIMIT_CONN: 'no',
    };
  }
  return {
    SECURITY_MODE: 'detect',
    USE_MODSECURITY: 'no',
    USE_LIMIT_REQ: 'no',
    USE_LIMIT_CONN: 'no',
    USE_BAD_BEHAVIOR: 'no',
    ALLOWED_METHODS: WEB_METHODS,
  };
}

/**
 * The variables of a domain's service. `upstream`: `http://IP:port` — an IP
 * address, BunkerWeb's nginx not reading `/etc/hosts`. Pupitre's probes get
 * through the whitelist with their secret header — never limited or banned,
 * otherwise a healthy domain would look down; the value is
 * `PROBE_SECRET_PLACEHOLDER`, replaced on the proxy's machine.
 */
export function serviceVariables(input: {
  route: ProxyRoute;
  upstream: string;
  acme: Pick<AcmeSettings, 'email' | 'server'> | null;
}): Record<string, string> {
  const { route, acme } = input;
  const letsEncrypt = route.tls && acme !== null;
  const redirect = route.tls && route.redirectHttps;
  return {
    SERVER_NAME: route.hostname,
    USE_REVERSE_PROXY: 'yes',
    REVERSE_PROXY_HOST: input.upstream,
    REVERSE_PROXY_URL: '/',
    AUTO_LETS_ENCRYPT: letsEncrypt ? 'yes' : 'no',
    // HTTPS without an authority: a self-signed certificate rather than nothing.
    GENERATE_SELF_SIGNED_SSL: route.tls && !letsEncrypt ? 'yes' : 'no',
    EMAIL_LETS_ENCRYPT: acme?.email ?? '',
    LETS_ENCRYPT_SERVER: acme?.server === 'zerossl' ? 'zerossl' : 'letsencrypt',
    USE_LETS_ENCRYPT_STAGING: acme?.server === 'staging' ? 'yes' : 'no',
    REDIRECT_HTTP_TO_HTTPS: redirect ? 'yes' : 'no',
    AUTO_REDIRECT_HTTP_TO_HTTPS: redirect ? 'yes' : 'no',
    USE_WHITELIST: 'yes',
    WHITELIST_HEADER_NAME: PROBE_HEADER,
    WHITELIST_HEADER_VALUE: `^${PROBE_SECRET_PLACEHOLDER}$`,
    ...wafPreset(route.waf),
  };
}

/**
 * What Pupitre set up for an application (and the machine it comes from, for
 * the central proxy): the list of its domains, kept in a file on the proxy's
 * machine. It is what says what to remove when a domain disappears, and which
 * services are not Pupitre's — BunkerWeb has no label to note it in.
 */
export type RouteRegistry = { hostnames: string[] };

export function parseRegistry(text: string | null): RouteRegistry {
  if (!text?.trim()) return { hostnames: [] };
  try {
    const parsed = JSON.parse(text) as { hostnames?: unknown };
    return {
      hostnames: Array.isArray(parsed.hostnames)
        ? parsed.hostnames.filter((value): value is string => typeof value === 'string')
        : [],
    };
  } catch {
    return { hostnames: [] };
  }
}

/** The file name of an application's registry: `{slug}[--{scope}].json`. */
export function registryFileName(name: string): string {
  return `${name.replace(/[^a-z0-9-]/gi, '-')}.json`;
}

export type ServicePlan = {
  create: string[];
  update: string[];
  remove: string[];
  /** Services that already exist in BunkerWeb without being Pupitre's. */
  foreign: string[];
};

/**
 * What must be done for an application to have exactly these domains. `owned`:
 * every domain Pupitre set up on this BunkerWeb, all applications together — an
 * existing service outside that list is not Pupitre's, it does not touch it.
 */
export function planServices(input: {
  /** The domains the application must have. */
  wanted: string[];
  /** Those Pupitre had set up for it. */
  previous: string[];
  /** The services that exist in BunkerWeb. */
  existing: string[];
  /** The domains Pupitre set up for the **other** applications. */
  others: string[];
}): ServicePlan {
  const existing = new Set(input.existing);
  const others = new Set(input.others);
  const owned = new Set([...input.previous, ...input.others]);
  const wanted = new Set(input.wanted);
  const plan: ServicePlan = { create: [], update: [], remove: [], foreign: [] };
  for (const hostname of wanted) {
    if (!existing.has(hostname)) plan.create.push(hostname);
    else if (owned.has(hostname)) plan.update.push(hostname);
    else plan.foreign.push(hostname);
  }
  // A domain passed to another application is now that one's: we only remove what
  // nobody claims anymore.
  for (const hostname of input.previous) {
    if (!wanted.has(hostname) && !others.has(hostname) && existing.has(hostname)) {
      plan.remove.push(hostname);
    }
  }
  return plan;
}

/**
 * The BunkerWeb installed by Pupitre: the all-in-one, ports 80 → 8080 and
 * 443 → 8443 (it runs without root rights and listens above 1024), the API
 * enabled, the web interface not — Pupitre stands in for it. The API token is in
 * `api.env`, generated on the machine and readable by its owner alone; it does
 * not appear here.
 */
export function renderBunkerwebCompose(): string {
  return stringify(
    {
      name: BUNKERWEB_PROJECT,
      services: {
        bunkerweb: {
          image: BUNKERWEB_IMAGE,
          container_name: BUNKERWEB_CONTAINER,
          restart: 'unless-stopped',
          ports: ['80:8080/tcp', '443:8443/tcp'],
          env_file: ['./api.env'],
          environment: {
            SERVICE_API: 'yes',
            SERVICE_UI: 'no',
            SERVICE_SCHEDULER: 'yes',
            MULTISITE: 'yes',
            SERVER_NAME: '',
            API_LISTEN_PORT: String(BUNKERWEB_API_PORT),
            // With nginx's setting (64), a domain of fifty-odd characters makes **the
            // whole** configuration be refused — BunkerWeb then silently goes back to the
            // previous one.
            SERVER_NAMES_HASH_BUCKET_SIZE: '256',
          },
          volumes: ['bunkerweb-data:/data'],
          labels: { 'io.pupitre.managed': 'bunkerweb' },
        },
      },
      volumes: { 'bunkerweb-data': {} },
    },
    { lineWidth: 0 },
  );
}
