import { z } from 'zod';
import type { UiLanguage } from '../i18n.js';
import { invalid } from '../validation.js';
import { proxySay } from './messages.js';

/**
 * Reverse proxies — the vocabulary, without executing anything.
 *
 * This module is imported by the screen as by the worker: it touches neither
 * SSH nor the network. What talks to a machine lives under `@pupitre/core/proxy`.
 *
 * ── Three notions, and not one more ─────────────────────────────────────────
 *   the connection  a proxy the panel can drive: its kind, where it is, how to
 *                   reach it. Stored in the database, one per machine for a
 *                   proxy "on the target".
 *   the route       a domain name that leads to an application on a target.
 *                   Stored in the database, unique per name: two applications
 *                   cannot claim the same domain, and it is a constraint, not
 *                   an `if`.
 *   the upstream    how the proxy reaches the application. It is the driver
 *                   that says it — a published port, a Kubernetes Service —
 *                   because only it knows how it exposes.
 */

/** The kinds the database knows. Each one declares its configuration in `catalog.ts`. */
export const PROXY_KINDS = ['traefik', 'bunkerweb', 'npm'] as const;
export const proxyKindSchema = z.enum(PROXY_KINDS);
export type ProxyKind = z.infer<typeof proxyKindSchema>;

/**
 * `target`: the proxy runs on a machine Pupitre drives over SSH — the one it
 * serves, or another through a link (the central proxy).
 * `remote`: it is elsewhere, outside the targets, and Pupitre only reaches it
 * through its API — Nginx Proxy Manager. It serves machines through links,
 * always.
 */
export const PROXY_PLACEMENTS = ['target', 'remote'] as const;
export const proxyPlacementSchema = z.enum(PROXY_PLACEMENTS);
export type ProxyPlacement = z.infer<typeof proxyPlacementSchema>;

export const PROXY_STATUSES = ['unknown', 'installing', 'ok', 'failed'] as const;
export type ProxyStatus = (typeof PROXY_STATUSES)[number];

export const ROUTE_STATUSES = ['pending', 'active', 'failed'] as const;
export type RouteStatus = (typeof ROUTE_STATUSES)[number];

// ─── domain names ────────────────────────────────────────────────────────────

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * A host name as a proxy routes it: lowercase, without a trailing dot, at least
 * two labels, no IP address, no wildcard. Wildcards will come with DNS-01
 * certificates; an IP address has no public certificate.
 */
export function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

export type HostnameProblem = 'empty' | 'tooLong' | 'wildcard' | 'ip' | 'noDot' | 'invalid';

/** What is wrong with a name, as data; `null` if it is fine. */
export function hostnameProblemOf(value: string): HostnameProblem | null {
  const host = normalizeHostname(value);
  if (host.length === 0) return 'empty';
  if (host.length > 253) return 'tooLong';
  if (host.includes('*')) return 'wildcard';
  if (/^[0-9.]+$/.test(host) || host.includes(':')) return 'ip';
  const labels = host.split('.');
  if (labels.length < 2) return 'noDot';
  if (!labels.every((label) => LABEL.test(label))) return 'invalid';
  return null;
}

export function hostnameProblem(value: string, language: UiLanguage): string | null {
  const problem = hostnameProblemOf(value);
  return problem === null ? null : proxySay(language)(`hostname.${problem}`);
}

export const hostnameSchema = z
  .string()
  .max(260)
  .transform(normalizeHostname)
  .superRefine((host, context) => {
    const problem = hostnameProblemOf(host);
    if (problem) context.addIssue({ code: 'custom', ...invalid(`hostname.${problem}`, { host }) });
  });

/**
 * A domain's protection by a proxy that is also a web application firewall
 * (WAF). Not applicable to a proxy that is not one — it ignores it.
 *   block   recognized attacks are blocked, abuses limited;
 *   detect  everything is inspected and logged, nothing is blocked — to make
 *           sure an application does not suffer from it before blocking;
 *   off     the proxy relays, without inspecting.
 */
export const WAF_MODES = ['block', 'detect', 'off'] as const;
export const wafModeSchema = z.enum(WAF_MODES);
export type WafMode = z.infer<typeof wafModeSchema>;

/** What is asked for a domain: the rest is derived from the proxy. */
export const routeInputSchema = z.object({
  hostname: hostnameSchema,
  /** Served over HTTPS, certificate obtained by the proxy. */
  tls: z.boolean().default(true),
  /** HTTP redirects to HTTPS. Not applicable without `tls`. */
  redirectHttps: z.boolean().default(true),
  /** The domain's protection, for a proxy that is also a WAF. */
  waf: wafModeSchema.default('block'),
});
export type RouteInput = z.infer<typeof routeInputSchema>;

/** An application's domains on a target: the whole list, without duplicates. */
export const routeListSchema = z
  .array(routeInputSchema)
  .max(20)
  .superRefine((routes, context) => {
    const seen = new Set<string>();
    for (const route of routes) {
      if (seen.has(route.hostname)) {
        context.addIssue({
          code: 'custom',
          ...invalid('routes.duplicate', { hostname: route.hostname }),
        });
      }
      seen.add(route.hostname);
    }
  });

// ─── the served certificate ──────────────────────────────────────────────────

/**
 * What the proxy presents for a domain, read from the proxy's machine.
 *   none     the route is not HTTPS;
 *   pending  the proxy serves its default certificate — issuance has not
 *            succeeded yet (DNS not propagated yet, port 80 closed…);
 *   valid    a real certificate, for this name, not expired;
 *   invalid  a certificate, but expired or for another name;
 *   unknown  the reading failed: no tool, no answer.
 */
export const CERTIFICATE_STATUSES = ['none', 'pending', 'valid', 'invalid', 'unknown'] as const;
export type CertificateStatus = (typeof CERTIFICATE_STATUSES)[number];

export const routeCertificateSchema = z.object({
  status: z.enum(CERTIFICATE_STATUSES),
  issuer: z.string().nullable().default(null),
  subject: z.string().nullable().default(null),
  notAfter: z.string().nullable().default(null),
});
export type RouteCertificate = z.infer<typeof routeCertificateSchema>;

// ─── the upstream ────────────────────────────────────────────────────────────

/**
 * How the proxy reaches the application. Provided by the driver: it knows
 * whether its runtime publishes a port on the machine or a Service in a
 * cluster. The proxy says which one it can reach; the pipeline does not have to
 * know which runtime it runs on.
 */
export type ProxyUpstream =
  /**
   * A port published on a machine. Without `host`, the proxy's — it reaches it at
   * its local address. With `host`, **another** machine, which the proxy reaches
   * through this address: that is the central proxy.
   */
  | { kind: 'port'; port: number; host?: string }
  | { kind: 'kubernetes'; namespace: string; service: string; port: number };

/** A private address (RFC 1918, ULA, loopback): clear-text traffic stays there. */
export function isPrivateAddress(address: string): boolean {
  if (/^10\.|^192\.168\.|^127\.|^169\.254\./.test(address)) return true;
  const match = /^172\.(\d+)\./.exec(address);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address)) return true; // CGNAT, Tailscale
  return /^(fc|fd)[0-9a-f]{2}:|^::1$/i.test(address);
}

export function isIPv4(address: string): boolean {
  return /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(address);
}

// ─── certificates ────────────────────────────────────────────────────────────

/**
 * The certificate authority a proxy installed by Pupitre queries. Not all of
 * them accept every one: each installation option says which ones
 * (`ProxyInstallOption.acmeServers`).
 */
export const ACME_SERVERS = ['production', 'staging', 'zerossl', 'custom'] as const;
export type AcmeServer = (typeof ACME_SERVERS)[number];
export const acmeSettingsSchema = z.object({
  email: z.string().email().max(254),
  server: z.enum(ACME_SERVERS).default('production'),
  /** With `custom`: an internal ACME (step-ca, Smallstep…), or Pebble in tests. */
  customUrl: z.string().url().max(500).nullable().default(null),
  /** The authority that signs the ACME URL itself, when it is not public (PEM). */
  caCertificate: z.string().max(20_000).nullable().default(null),
});
export type AcmeSettings = z.infer<typeof acmeSettingsSchema>;

export const ACME_DIRECTORIES: Record<Exclude<AcmeServer, 'custom'>, string> = {
  production: 'https://acme-v02.api.letsencrypt.org/directory',
  staging: 'https://acme-staging-v02.api.letsencrypt.org/directory',
  zerossl: 'https://acme.zerossl.com/v2/DV90',
};

export function acmeDirectory(acme: AcmeSettings): string {
  if (acme.server === 'custom') {
    if (!acme.customUrl) throw new Error('custom ACME server without a URL');
    return acme.customUrl;
  }
  return ACME_DIRECTORIES[acme.server];
}

// ─── what a proxy can do ─────────────────────────────────────────────────────

/**
 * What a proxy can do, so that the screen only offers that and the API refuses
 * the rest. We ask the proxy what it can do, not which one it is — the same rule
 * as for the drivers' firewall.
 */
export type ProxyCapabilities = {
  /** It obtains certificates itself (ACME). */
  autoTls: boolean;
  /** It can serve HTTPS, even with a default certificate. */
  https: boolean;
  /** It can redirect HTTP to HTTPS. */
  redirectHttps: boolean;
  /** It is also a web application firewall: each domain has its protection (`WafMode`). */
  waf: boolean;
  /**
   * How it reaches another machine — the central proxy: through any address,
   * through IPv4 only, or not at all.
   */
  remoteUpstream: 'any' | 'ipv4' | 'none';
};

/**
 * What a kind of proxy declares about itself, without executing anything:
 * reading its configuration, describing itself, saying what it can do. The
 * screen and the API use it; adding a proxy means writing one (`catalog.ts`).
 */
export type ProxyDescriptor<C = unknown> = {
  /** The kind's name, for the screen: "Traefik", "BunkerWeb". */
  label: string;
  /** Where it runs: on a machine driven over SSH, or elsewhere, reached through its API. */
  placement: ProxyPlacement;
  parseConfig(config: unknown): C;
  /**
   * For a `remote` proxy: its secrets (API credentials), validated. They are
   * encrypted in the database and only come out toward the worker.
   */
  parseSecrets?(secrets: unknown): Record<string, string>;
  /**
   * For a `remote` proxy: the machine where it receives visitors — the one a
   * domain's DNS must point to.
   */
  entrypointHost?(config: C): string;
  /** A line for the screen, in its language: enough to recognize the connection. */
  describe(config: C, language: UiLanguage): string;
  capabilities(config: C): ProxyCapabilities;
  /** The certificate authority set by Pupitre, to name it; `null` otherwise. */
  acme(config: C): Pick<AcmeSettings, 'email' | 'server'> | null;
};
