import { Resolver } from 'node:dns/promises';
import { connect, type TLSSocket } from 'node:tls';
import {
  isLocalHostname,
  registrableDomainOf,
  type DomainInspection,
} from '../domain-inspection.js';
import { tldOf } from '../monitors/catalog.js';
import { classifyAddress, type Cidr } from '../monitors/ssrf.js';
import { MONITOR_MAX_RESPONSE_BYTES } from '../monitors/state.js';
import { readRdapDomain, rdapEndpointFor } from './domain.js';
import { PUBLIC_ONLY, decodeBody, guardedFetch } from './fetch.js';
import type { UiLanguage } from '../i18n.js';
import { probeSay } from './messages.js';
import { ProbeTimeoutError, SsrfBlockedError, messageOf, resolveGuarded } from './net.js';

/**
 * Le relevé d'un domaine, pour son tiroir : DNS, adresses, RDAP, certificat.
 *
 * Il reprend les sondes de supervision — même client RDAP, même garde réseau —
 * mais n'en rend aucun verdict : il montre. Les quatre lectures partent
 * ensemble une fois le nom résolu, chacune bornée, et l'échec de l'une ne
 * prive pas des autres.
 *
 * Les gardes ne changent pas. RDAP ne joint que des adresses publiques (voir
 * `domain.ts`). La poignée de main TLS va à l'adresse du nom, sous la liste
 * d'autorisation de la supervision (`MONITOR_ALLOWED_CIDRS`) : un domaine qui
 * résout vers une adresse interne n'est pas sondé sans qu'on l'ait permis.
 * Le DNS, lui, ne joint que le résolveur du système : les adresses obtenues
 * sont des données.
 */

const DNS_TIMEOUT_MS = 4_000;
const RDAP_TIMEOUT_MS = 8_000;
const TLS_TIMEOUT_MS = 6_000;
const MAX_REVERSE = 4;
const DAY_MS = 86_400_000;

export type DomainInspectInput = {
  hostname: string;
  tls: boolean;
  /** Les machines du proxy qui sert le nom (nom ou adresse) ; vide si on l'ignore. */
  expectedHosts: string[];
  allowlist: readonly Cidr[];
  /** La langue des erreurs relevées — celle de l'instance. */
  language?: UiLanguage;
};

function resolver(): Resolver {
  return new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
}

/** Une question DNS dont le « rien » est une réponse, pas une panne. */
async function answer<T>(question: Promise<T[]>): Promise<T[]> {
  try {
    return await question;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOTFOUND' || code === 'ENODATA') return [];
    throw error;
  }
}

async function resolveName(
  hostname: string,
  language: UiLanguage,
): Promise<DomainInspection['dns']> {
  const dns = resolver();
  try {
    const [cname, a, aaaa] = await Promise.all([
      answer(dns.resolveCname(hostname)),
      answer(dns.resolve4(hostname, { ttl: true })),
      answer(dns.resolve6(hostname, { ttl: true })),
    ]);
    const ttls = [...a, ...aaaa].map((record) => record.ttl);
    const empty = cname.length === 0 && a.length === 0 && aaaa.length === 0;
    return {
      status: empty ? 'not_found' : 'ok',
      error: null,
      cname,
      a: a.map((record) => record.address),
      aaaa: aaaa.map((record) => record.address),
      ttl: ttls.length === 0 ? null : Math.min(...ttls),
    };
  } catch (error) {
    return {
      status: 'error',
      error: messageOf(error, language),
      cname: [],
      a: [],
      aaaa: [],
      ttl: null,
    };
  }
}

async function zoneOf(domain: string): Promise<DomainInspection['zone']> {
  const dns = resolver();
  const settle = async <T>(question: Promise<T[]>): Promise<T[]> =>
    answer(question).catch(() => []);
  const [ns, mx, caa] = await Promise.all([
    settle(dns.resolveNs(domain)),
    settle(dns.resolveMx(domain)),
    settle(dns.resolveCaa(domain)),
  ]);
  return {
    name: domain,
    ns: ns.map((name) => name.toLowerCase()).sort(),
    mx: mx
      .sort((a, b) => a.priority - b.priority)
      .map((record) => `${record.priority} ${record.exchange.toLowerCase()}`),
    caa: caa.map((record) => {
      const critical = record.critical ?? 0;
      const entry = Object.entries(record).find(([key]) => key !== 'critical' && key !== 'type');
      return entry ? `${critical} ${entry[0]} "${String(entry[1])}"` : `${critical} ?`;
    }),
  };
}

async function reverseOf(address: string): Promise<string[]> {
  return answer(resolver().reverse(address)).catch(() => []);
}

/** Les adresses d'une machine, qu'on la connaisse par son nom ou son adresse. */
async function addressesOf(host: string): Promise<string[]> {
  if (classifyAddress(host) !== null) return [host];
  const dns = resolver();
  const [a, aaaa] = await Promise.all([
    answer(dns.resolve4(host)).catch(() => []),
    answer(dns.resolve6(host)).catch(() => []),
  ]);
  return [...a, ...aaaa];
}

function emptyRegistration(
  status: DomainInspection['registration']['status'],
  domain: string | null,
  extra: Partial<DomainInspection['registration']> = {},
): DomainInspection['registration'] {
  return {
    status,
    domain,
    server: null,
    error: null,
    registrar: null,
    registeredOn: null,
    expiresOn: null,
    lastChangedOn: null,
    daysRemaining: null,
    nameservers: [],
    statuses: [],
    ...extra,
  };
}

async function registrationOf(
  hostname: string,
  language: UiLanguage,
): Promise<DomainInspection['registration']> {
  if (isLocalHostname(hostname)) return emptyRegistration('local', null);
  const domain = registrableDomainOf(hostname);
  if (domain === null) return emptyRegistration('unsupported', null);

  const endpoint = await rdapEndpointFor(tldOf(domain)).catch(() => null);
  if (endpoint === null) return emptyRegistration('unsupported', domain);

  const server = new URL(endpoint.base).host;
  const result = await guardedFetch({
    url: `${endpoint.base}domain/${encodeURIComponent(domain)}`,
    method: 'GET',
    timeoutMs: RDAP_TIMEOUT_MS,
    maxBytes: MONITOR_MAX_RESPONSE_BYTES,
    readBody: true,
    allowlist: PUBLIC_ONLY,
    requireHttps: true,
    accept: 'application/rdap+json, application/json',
    language,
  });
  if (!result.ok) return emptyRegistration('error', domain, { server, error: result.detail });
  if (result.status === 404) return emptyRegistration('not_found', domain, { server });
  if (result.status !== 200) {
    return emptyRegistration('error', domain, { server, error: `HTTP ${result.status}` });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(decodeBody(result.body, result.headers['content-type']));
  } catch {
    return emptyRegistration('error', domain, {
      server,
      error: probeSay(language)('inspect.rdapUnreadable'),
    });
  }
  const facts = readRdapDomain(payload);
  return {
    status: 'ok',
    domain,
    server,
    error: null,
    registrar: facts.registrar,
    registeredOn: facts.registeredOn,
    expiresOn: facts.expiresOn,
    lastChangedOn: facts.lastChangedOn,
    daysRemaining:
      facts.expiresOn === null
        ? null
        : Math.floor((Date.parse(facts.expiresOn) - Date.now()) / DAY_MS),
    nameservers: facts.nameservers,
    statuses: facts.statuses,
  };
}

function emptyCertificate(
  status: DomainInspection['certificate']['status'],
  extra: Partial<DomainInspection['certificate']> = {},
): DomainInspection['certificate'] {
  return {
    status,
    error: null,
    address: null,
    authorized: null,
    authorizationError: null,
    subject: null,
    issuer: null,
    issuerOrganization: null,
    altNames: [],
    validFrom: null,
    validTo: null,
    daysRemaining: null,
    serialNumber: null,
    fingerprint256: null,
    protocol: null,
    cipher: null,
    ...extra,
  };
}

function field(fields: unknown, key: string): string | null {
  const value = (fields as Record<string, string | string[] | undefined> | undefined)?.[key];
  const text = Array.isArray(value) ? value[0] : value;
  return typeof text === 'string' && text !== '' ? text : null;
}

function isoOrNull(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function certificateOf(
  hostname: string,
  allowlist: readonly Cidr[],
  language: UiLanguage,
): Promise<DomainInspection['certificate']> {
  let address: string;
  try {
    address = (await resolveGuarded(hostname, allowlist)).address;
  } catch (error) {
    // Un nom qui ne résout pas n'est pas une adresse refusée : c'est une panne.
    const unresolved =
      error instanceof SsrfBlockedError &&
      (error.refusal.key === 'reason.unresolved' || error.refusal.key === 'reason.noAddress');
    return emptyCertificate(
      error instanceof SsrfBlockedError && !unresolved ? 'blocked' : 'error',
      {
        error: messageOf(error, language),
      },
    );
  }

  let socket: TLSSocket;
  try {
    socket = await new Promise<TLSSocket>((resolve, reject) => {
      // Connexion à l'adresse contrôlée, SNI sur le nom. La chaîne n'est pas
      // exigée valide : on veut **voir** le certificat, même mauvais, et dire
      // pourquoi il l'est.
      const opened = connect({
        host: address,
        port: 443,
        servername: hostname,
        rejectUnauthorized: false,
        timeout: TLS_TIMEOUT_MS,
      });
      opened.once('secureConnect', () => resolve(opened));
      opened.once('timeout', () => {
        opened.destroy();
        reject(new ProbeTimeoutError(TLS_TIMEOUT_MS));
      });
      opened.once('error', reject);
    });
  } catch (error) {
    return emptyCertificate('error', { address, error: messageOf(error, language) });
  }

  try {
    const peer = socket.getPeerCertificate(false);
    if (!peer || !peer.valid_to) {
      return emptyCertificate('error', { address, error: probeSay(language)('noCertificate') });
    }
    const validTo = isoOrNull(peer.valid_to);
    const authorizationError = socket.authorizationError ? String(socket.authorizationError) : null;
    return {
      status: 'ok',
      error: null,
      address,
      authorized: socket.authorized,
      authorizationError,
      subject: field(peer.subject, 'CN'),
      issuer: field(peer.issuer, 'CN') ?? field(peer.issuer, 'O'),
      issuerOrganization: field(peer.issuer, 'O'),
      altNames: (peer.subjectaltname ?? '')
        .split(',')
        .map((entry) => entry.trim().replace(/^(DNS|IP Address):/, ''))
        .filter(Boolean),
      validFrom: isoOrNull(peer.valid_from),
      validTo,
      daysRemaining:
        validTo === null ? null : Math.floor((Date.parse(validTo) - Date.now()) / DAY_MS),
      serialNumber: peer.serialNumber ?? null,
      fingerprint256: peer.fingerprint256 ?? null,
      protocol: socket.getProtocol(),
      cipher: socket.getCipher()?.name ?? null,
    };
  } finally {
    socket.destroy();
  }
}

export async function inspectDomain(input: DomainInspectInput): Promise<DomainInspection> {
  const language = input.language ?? 'fr';
  const hostname = input.hostname.toLowerCase().replace(/\.$/, '');
  const dns = await resolveName(hostname, language);
  const resolved = [
    ...dns.a.map((address) => ({ address, family: 4 as const })),
    ...dns.aaaa.map((address) => ({ address, family: 6 as const })),
  ];
  const zoneName = isLocalHostname(hostname) ? null : registrableDomainOf(hostname);

  const [zone, reverse, expected, registration, certificate] = await Promise.all([
    zoneName ? zoneOf(zoneName) : Promise.resolve(null),
    Promise.all(resolved.slice(0, MAX_REVERSE).map((entry) => reverseOf(entry.address))),
    Promise.all(input.expectedHosts.map((host) => addressesOf(host))).then((lists) => [
      ...new Set(lists.flat()),
    ]),
    registrationOf(hostname, language),
    input.tls
      ? certificateOf(hostname, input.allowlist, language)
      : Promise.resolve(emptyCertificate('http')),
  ]);

  const addresses = resolved.map((entry, index) => ({
    address: entry.address,
    family: entry.family,
    scope: classifyAddress(entry.address),
    reverse: reverse[index] ?? [],
  }));

  return {
    hostname,
    checkedAt: new Date().toISOString(),
    dns,
    zone,
    addresses,
    pointing: {
      status:
        expected.length === 0 || addresses.length === 0
          ? 'unknown'
          : addresses.some((entry) => expected.includes(entry.address))
            ? 'match'
            : 'mismatch',
      expected,
    },
    registration,
    certificate,
  };
}
