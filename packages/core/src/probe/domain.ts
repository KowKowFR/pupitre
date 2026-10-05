import { z } from 'zod';
import {
  domainConfigSchema,
  tldOf,
  tldPublishesRdap,
  type DomainConfig,
} from '../monitors/catalog.js';
import { MONITOR_MAX_RESPONSE_BYTES, type CheckResult } from '../monitors/state.js';
import { PUBLIC_ONLY, decodeBody, guardedFetch } from './fetch.js';
import { foldForSearch } from './keyword.js';
import type { UiLanguage } from '../i18n.js';
import { probeSay } from './messages.js';
import type { MonitorProbe, ProbeContext } from './types.js';

/**
 * Domain expiry probe, **through RDAP**.
 *
 * ── RDAP and not WHOIS ──────────────────────────────────────────────────────
 * A decision already made, and it fits in one sentence: RDAP returns JSON whose
 * shape is specified (RFC 9083), WHOIS returns free text whose format changes
 * from one registry to the next. Writing a WHOIS parser means writing forty
 * parsers and getting the forty-first wrong — at the precise moment when the lie
 * costs the most, since we are talking about the date a domain disappears.
 *
 * ── Finding the right server ────────────────────────────────────────────────
 * IANA publishes the `dns.json` bootstrap list: TLD → RDAP server. Both extremes
 * are bad. Fetching it at each query means 71 KiB and a round trip to read a
 * date that moves once a year. Hard-coding it means letting it go stale: new
 * TLDs appear, registries move.
 *
 * Hence: an **in-memory cache, one week**, filled lazily at first need; on a
 * network failure, **an embedded seed** covering the TLDs an instance is likely
 * to monitor, and a ten-minute failure cache so as not to hammer IANA. A worker
 * therefore makes *one* bootstrap request per week, and keeps working without
 * it.
 *
 * ── The SSRF guard, which is not the same as for the other probes ───────────
 * The other probes reach a target **the operator chose**, hence the existence of
 * `MONITOR_ALLOWED_CIDRS`: it is the operator who decides which internal ranges
 * their panel may reach.
 *
 * Here, nobody chose the destination. The operator enters `example.com`; the
 * server reached is the one a third-party file designates, resolved by a DNS
 * that can lie. Letting this request inherit the allow list would amount to
 * saying: "a poisoned bootstrap entry can reach my 10.0.0.0/8". Hence
 * **`PUBLIC_ONLY`**: public addresses only, whatever the panel's configuration.
 * A registry is on the public Internet by definition; if it resolves to a
 * private address, it is an attack, not an exception to accommodate. The same
 * rule for the bootstrap list itself, whose URL is hard-coded here and never
 * derived from an input.
 *
 * On top of that comes `requireHttps`: an RDAP response altered in transit would
 * say anything about an expiry date, and the only cost of requiring it is
 * refusing registries that do not exist — the bootstrap list only publishes
 * `https` URLs.
 */

// ─── bootstrap list ───────────────────────────────────────────────────────────

const IANA_BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';

/** One week: the list moves by a few entries a month, not an hour. */
const BOOTSTRAP_TTL_MS = 7 * 86_400_000;
/** After a failure, we retry in ten minutes — not at every probe. */
const BOOTSTRAP_RETRY_MS = 10 * 60_000;
const BOOTSTRAP_TIMEOUT_MS = 15_000;

/**
 * Fallback seed. **It is not a copy of IANA's list** — copying it would mean
 * letting 71 KiB go stale. It is the bare minimum for an instance without
 * access to `data.iana.org` to keep monitoring the domains monitored in
 * practice: the common gTLDs and the French-speaking TLDs. Taken from the list
 * of 2026-09-09.
 */
const BOOTSTRAP_SEED: ReadonlyMap<string, string> = new Map([
  ['com', 'https://rdap.verisign.com/com/v1/'],
  ['net', 'https://rdap.verisign.com/net/v1/'],
  ['org', 'https://rdap.publicinterestregistry.org/rdap/'],
  ['info', 'https://rdap.identitydigital.services/rdap/'],
  ['biz', 'https://rdap.nic.biz/'],
  ['dev', 'https://pubapi.registry.google/rdap/'],
  ['app', 'https://pubapi.registry.google/rdap/'],
  ['xyz', 'https://rdap.centralnic.com/xyz/'],
  ['cloud', 'https://rdap.registry.cloud/rdap/'],
  ['online', 'https://rdap.radix.host/rdap/'],
  ['site', 'https://rdap.radix.host/rdap/'],
  ['tech', 'https://rdap.radix.host/rdap/'],
  ['store', 'https://rdap.radix.host/rdap/'],
  ['pro', 'https://rdap.identitydigital.services/rdap/'],
  ['live', 'https://rdap.identitydigital.services/rdap/'],
  ['email', 'https://rdap.identitydigital.services/rdap/'],
  ['agency', 'https://rdap.identitydigital.services/rdap/'],
  ['digital', 'https://rdap.identitydigital.services/rdap/'],
  ['solutions', 'https://rdap.identitydigital.services/rdap/'],
  ['systems', 'https://rdap.identitydigital.services/rdap/'],
  ['fr', 'https://rdap.nic.fr/'],
  ['re', 'https://rdap.nic.re/'],
  ['pm', 'https://rdap.nic.pm/'],
  ['yt', 'https://rdap.nic.yt/'],
  ['tf', 'https://rdap.nic.tf/'],
  ['wf', 'https://rdap.nic.wf/'],
  ['ovh', 'https://rdap.nic.ovh/'],
  ['paris', 'https://rdap.nic.paris/'],
  ['bzh', 'https://rdap.nic.bzh/'],
  ['alsace', 'https://rdap.nic.alsace/'],
  ['corsica', 'https://rdap.nic.corsica/'],
  ['nl', 'https://rdap.sidn.nl/'],
  ['pl', 'https://rdap.dns.pl/'],
  ['uk', 'https://rdap.nominet.uk/uk/'],
  ['ca', 'https://rdap.ca.fury.ca/rdap/'],
  ['cz', 'https://rdap.nic.cz/'],
  ['tv', 'https://rdap.nic.tv/'],
  ['cc', 'https://tld-rdap.verisign.com/cc/v1/'],
]);

/** The shape of `dns.json`, as RFC 9224 describes it. */
const bootstrapSchema = z.object({
  services: z.array(z.tuple([z.array(z.string()), z.array(z.string())])),
});

/** TLD → base URL, from the bootstrap document. */
export function readBootstrap(payload: unknown): Map<string, string> {
  const parsed = bootstrapSchema.safeParse(payload);
  const map = new Map<string, string>();
  if (!parsed.success) return map;
  for (const [tlds, urls] of parsed.data.services) {
    // We keep the first https URL: the list sometimes offers two, and an RDAP
    // response in clear cannot be verified.
    const base = urls.find((url) => url.startsWith('https://'));
    if (base === undefined) continue;
    for (const tld of tlds) map.set(tld.toLowerCase(), base.endsWith('/') ? base : `${base}/`);
  }
  return map;
}

type BootstrapCache = { map: Map<string, string> | null; until: number };
let cache: BootstrapCache = { map: null, until: 0 };

/** For tests and the harness: start again from an empty cache. */
export function resetRdapBootstrapCache(): void {
  cache = { map: null, until: 0 };
}

async function bootstrapMap(): Promise<Map<string, string> | null> {
  if (Date.now() < cache.until) return cache.map;

  const result = await guardedFetch({
    url: IANA_BOOTSTRAP_URL,
    method: 'GET',
    timeoutMs: BOOTSTRAP_TIMEOUT_MS,
    // 71 KiB on 2026-09-09; the shared cap leaves room without letting
    // data.iana.org serve us an endless stream.
    maxBytes: MONITOR_MAX_RESPONSE_BYTES,
    readBody: true,
    allowlist: PUBLIC_ONLY,
    requireHttps: true,
    accept: 'application/json',
    // A failure is only cached, never shown: its wording does not matter.
    language: 'en',
  });

  if (!result.ok || result.status !== 200 || result.truncated) {
    // Failure cached too: otherwise fifty domain probes would each retry, every six
    // hours, a service that does not answer.
    cache = { map: cache.map, until: Date.now() + BOOTSTRAP_RETRY_MS };
    return cache.map;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(decodeBody(result.body, result.headers['content-type']));
  } catch {
    cache = { map: cache.map, until: Date.now() + BOOTSTRAP_RETRY_MS };
    return cache.map;
  }

  const map = readBootstrap(payload);
  if (map.size === 0) {
    cache = { map: cache.map, until: Date.now() + BOOTSTRAP_RETRY_MS };
    return cache.map;
  }

  cache = { map, until: Date.now() + BOOTSTRAP_TTL_MS };
  return map;
}

export type RdapEndpoint = { base: string; source: 'iana' | 'seed' };

/** A TLD's RDAP server: IANA's list first, the seed next. */
export async function rdapEndpointFor(tld: string): Promise<RdapEndpoint | null> {
  const key = tld.toLowerCase();
  const live = await bootstrapMap();
  const fromIana = live?.get(key);
  if (fromIana !== undefined) return { base: fromIana, source: 'iana' };
  const seeded = BOOTSTRAP_SEED.get(key);
  return seeded === undefined ? null : { base: seeded, source: 'seed' };
}

// ─── reading an RDAP response ─────────────────────────────────────────────────

export type RdapDomainFacts = {
  ldhName: string | null;
  /** ISO 8601, as the registry writes it. `null` if the registry does not publish it. */
  expiresOn: string | null;
  registeredOn: string | null;
  lastChangedOn: string | null;
  registrar: string | null;
  nameservers: string[];
  /** EPP statuses, normalized to lowercase without spaces or dashes. */
  statuses: string[];
};

const rdapDomainSchema = z.object({
  ldhName: z.string().optional(),
  status: z.array(z.string()).optional(),
  events: z
    .array(z.object({ eventAction: z.string().optional(), eventDate: z.string().optional() }))
    .optional(),
  nameservers: z.array(z.object({ ldhName: z.string().optional() })).optional(),
  entities: z
    .array(
      z.object({
        roles: z.array(z.string()).optional(),
        handle: z.string().optional(),
        vcardArray: z.unknown().optional(),
        publicIds: z.array(z.object({ identifier: z.string().optional() })).optional(),
      }),
    )
    .optional(),
});

/**
 * An entity's readable name, in its vCard. The jCard form is an array of arrays
 * (`['fn', {}, 'text', 'OVH SAS']`) that no Zod schema describes elegantly: we
 * walk it by hand rather than pretend otherwise.
 */
function vcardFullName(vcardArray: unknown): string | null {
  if (!Array.isArray(vcardArray) || vcardArray.length < 2) return null;
  const entries = vcardArray[1];
  if (!Array.isArray(entries)) return null;
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry[0] !== 'fn') continue;
    const value = entry[3];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

function eventDate(
  events: ReadonlyArray<{ eventAction?: string; eventDate?: string }> | undefined,
  action: string,
): string | null {
  const found = events?.find((event) => event.eventAction?.toLowerCase() === action);
  const raw = found?.eventDate;
  if (raw === undefined) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * The facts, extracted from an RDAP response. A **pure** function: it is what
 * the tests exercise on real frozen responses, without network.
 *
 * It is deliberately tolerant. Registries do not all fill the same fields —
 * `.com` uppercases its `ldhName` and publishes three EPP statuses, `.fr`
 * lowercases its own and often only announces `active` — and a missing field is
 * not an invalid response. What is missing is `null`; what is *really* missing
 * (the expiry date) is handled by the verdict, not here.
 */
export function readRdapDomain(payload: unknown): RdapDomainFacts {
  const parsed = rdapDomainSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      ldhName: null,
      expiresOn: null,
      registeredOn: null,
      lastChangedOn: null,
      registrar: null,
      nameservers: [],
      statuses: [],
    };
  }
  const data = parsed.data;

  const registrarEntity = data.entities?.find((entity) =>
    entity.roles?.some((role) => role.toLowerCase() === 'registrar'),
  );

  return {
    ldhName: data.ldhName?.toLowerCase().replace(/\.$/, '') ?? null,
    expiresOn: eventDate(data.events, 'expiration'),
    registeredOn: eventDate(data.events, 'registration'),
    lastChangedOn: eventDate(data.events, 'last changed'),
    registrar:
      registrarEntity === undefined
        ? null
        : (vcardFullName(registrarEntity.vcardArray) ??
          registrarEntity.publicIds?.[0]?.identifier ??
          registrarEntity.handle ??
          null),
    nameservers: (data.nameservers ?? [])
      .map((server) => server.ldhName?.toLowerCase().replace(/\.$/, '') ?? '')
      .filter((name) => name !== '')
      .sort(),
    // "client transfer prohibited" (RFC 9083) and "clientTransferProhibited" (raw
    // EPP form) mean the same thing; we flatten both.
    statuses: (data.status ?? []).map((status) => status.toLowerCase().replace(/[\s_-]+/g, '')),
  };
}

// ─── verdict ──────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

function daysUntil(iso: string, now: Date): number {
  return Math.floor((new Date(iso).getTime() - now.getTime()) / DAY_MS);
}

/** "25/09/2026" in French; the ISO date, unambiguous, elsewhere. */
function displayDate(iso: string, language: UiLanguage): string {
  const [date] = iso.split('T');
  const parts = (date ?? iso).split('-');
  if (parts.length !== 3) return iso;
  return language === 'fr' ? `${parts[2]}/${parts[1]}/${parts[0]}` : (date ?? iso);
}

export type DomainVerdict = {
  outcome: 'healthy' | 'unhealthy';
  detail: string | null;
  daysRemaining: number | null;
};

/**
 * The judgment, separate from the request to be testable on fixtures.
 *
 * ── "Expires soon" in a state machine that only has three boxes ─────────────
 * `healthy / unhealthy / unreachable`. A domain expiring in twelve days is down
 * in none of these ways: it is *at risk*. None of the three says it, and there is
 * no fourth — adding one would touch the verdict, the `health_status` column,
 * the screen's indicator and a migration.
 *
 * We therefore keep `unhealthy`, exactly as the TLS probe already decided for
 * its notice period, and **the sentence carries the truth the state does not
 * carry**: "expires in 12 days (on 25/09/2026) — within the 30-day notice". The
 * right word is in the detail and in `uptimeMeans`; the state can only say "it
 * needs attention". It is a compromise, and it is flagged as such rather than
 * disguised.
 *
 * Several findings can come together — an expiry close by *and* a changed
 * registrar. We return them all: saying only one would make the other disappear
 * from the alert message, and the second is often the more serious.
 */
export function judgeDomain(
  facts: RdapDomainFacts,
  config: DomainConfig,
  now: Date,
  language: UiLanguage,
): DomainVerdict {
  const say = probeSay(language);
  const problems: string[] = [];
  const notes: string[] = [];

  const daysRemaining = facts.expiresOn === null ? null : daysUntil(facts.expiresOn, now);

  if (facts.expiresOn === null || daysRemaining === null) {
    // The registry answered and knows the domain: it *is* registered. Not
    // publishing a date is not an outage, it is a limit of that registry — and
    // keeping quiet about it would suggest we monitor the expiry.
    notes.push(say('domain.noExpiry'));
  } else if (daysRemaining < 0) {
    problems.push(
      say('domain.expired', {
        count: -daysRemaining,
        date: displayDate(facts.expiresOn, language),
      }),
    );
  } else if (daysRemaining < config.warnDays) {
    problems.push(
      say('domain.expiresSoon', {
        count: daysRemaining,
        date: displayDate(facts.expiresOn, language),
        warnDays: config.warnDays,
      }),
    );
  }

  if (config.expectedRegistrar !== null) {
    const expected = foldForSearch(config.expectedRegistrar);
    const actual = facts.registrar === null ? null : foldForSearch(facts.registrar);
    if (actual === null) {
      notes.push(say('domain.noRegistrar'));
    } else if (!actual.includes(expected)) {
      problems.push(
        say('domain.registrar', {
          actual: facts.registrar ?? '',
          expected: config.expectedRegistrar,
        }),
      );
    }
  }

  if (config.expectedNameserverSuffix !== null) {
    const suffix = config.expectedNameserverSuffix.toLowerCase().replace(/^\.|\.$/g, '');
    if (facts.nameservers.length === 0) {
      notes.push(say('domain.noNameservers'));
    } else if (!facts.nameservers.some((name) => name === suffix || name.endsWith(`.${suffix}`))) {
      problems.push(
        say('domain.nameservers', { suffix, nameservers: facts.nameservers.join(', ') }),
      );
    }
  }

  if (config.transferLock === 'required') {
    const locked = facts.statuses.some(
      (status) => status === 'clienttransferprohibited' || status === 'servertransferprohibited',
    );
    if (!locked) {
      problems.push(
        say('domain.noLock', {
          statuses:
            facts.statuses.length === 0
              ? say('domain.noStatuses')
              : say('domain.statuses', { statuses: facts.statuses.join(', ') }),
        }),
      );
    }
  }

  const all = [...problems, ...notes];
  return {
    outcome: problems.length > 0 ? 'unhealthy' : 'healthy',
    detail: all.length === 0 ? null : all.join(' ; '),
    daysRemaining,
  };
}

// ─── the probe ────────────────────────────────────────────────────────────────

function emptyMetrics(rdapServer: string | null) {
  return {
    daysRemaining: null,
    expiresOn: null,
    registrar: null,
    nameservers: null,
    eppStatus: null,
    registeredOn: null,
    lastChangedOn: null,
    rdapServer,
    latencyMs: null,
  };
}

async function runDomain(config: DomainConfig, language: UiLanguage): Promise<CheckResult> {
  const say = probeSay(language);
  const tld = tldOf(config.domain);
  const endpoint = await rdapEndpointFor(tld);

  if (endpoint === null) {
    // Normally impossible: the catalog refuses at creation the TLDs known to have
    // no RDAP. We still get here if the bootstrap list is unreachable *and* the TLD
    // is not in the seed, or for an `xn--` the catalog lets through for lack of a
    // ruling.
    const known = tldPublishesRdap(tld);
    return {
      outcome: 'unreachable',
      latencyMs: null,
      detail: known === false ? say('domain.noRdap', { tld }) : say('domain.noRdapServer', { tld }),
      metrics: emptyMetrics(null),
    };
  }

  const server = new URL(endpoint.base).host;
  const result = await guardedFetch({
    url: `${endpoint.base}domain/${encodeURIComponent(config.domain)}`,
    method: 'GET',
    timeoutMs: config.timeoutMs,
    maxBytes: MONITOR_MAX_RESPONSE_BYTES,
    readBody: true,
    // Public addresses only: see this file's header. The server is not chosen by
    // the operator, so it does not inherit their openings.
    allowlist: PUBLIC_ONLY,
    requireHttps: true,
    accept: 'application/rdap+json, application/json',
    language,
  });

  if (!result.ok) {
    return {
      outcome: 'unreachable',
      latencyMs: null,
      detail: say('domain.registry', { server, detail: result.detail }),
      metrics: emptyMetrics(server),
    };
  }

  if (result.status === 404) {
    // The only case where the registry really tells us something bad about the
    // domain: it does not know it. Either it expired and was purged, or it is not
    // the registered name — a subdomain, typically.
    return {
      outcome: 'unhealthy',
      latencyMs: result.latencyMs,
      detail: say('domain.unknown', { server, domain: config.domain }),
      metrics: { ...emptyMetrics(server), latencyMs: result.latencyMs },
    };
  }

  if (result.status !== 200) {
    // 429, 5xx, HTML error page…: the registry is unwell, not the domain.
    return {
      outcome: 'unreachable',
      latencyMs: result.latencyMs,
      detail: say('domain.registryStatus', { server, status: result.status }),
      metrics: { ...emptyMetrics(server), latencyMs: result.latencyMs },
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(decodeBody(result.body, result.headers['content-type']));
  } catch {
    return {
      outcome: 'unreachable',
      latencyMs: result.latencyMs,
      detail: say('domain.unreadable', { server }),
      metrics: { ...emptyMetrics(server), latencyMs: result.latencyMs },
    };
  }

  const facts = readRdapDomain(payload);
  const verdict = judgeDomain(facts, config, new Date(), language);

  return {
    outcome: verdict.outcome,
    latencyMs: result.latencyMs,
    detail: verdict.detail,
    metrics: {
      daysRemaining: verdict.daysRemaining,
      expiresOn: facts.expiresOn,
      registrar: facts.registrar,
      nameservers: facts.nameservers.length === 0 ? null : facts.nameservers.join(', '),
      eppStatus: facts.statuses.length === 0 ? null : facts.statuses.join(', '),
      registeredOn: facts.registeredOn,
      lastChangedOn: facts.lastChangedOn,
      rdapServer: server,
      latencyMs: result.latencyMs,
    },
  };
}

export const domainProbe: MonitorProbe = {
  type: 'domain',
  async run(config, ctx: ProbeContext): Promise<CheckResult> {
    const parsed = domainConfigSchema.safeParse(config);
    if (!parsed.success) {
      return {
        outcome: 'unreachable',
        latencyMs: null,
        detail: probeSay(ctx.language)('invalidConfig', {
          issues: parsed.error.issues.map((issue) => issue.message).join(', '),
        }),
        metrics: {},
      };
    }
    return runDomain(parsed.data, ctx.language);
  },
};
