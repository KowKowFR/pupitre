import { z } from 'zod';

/**
 * What we know about a domain when we look at it closely: where it points, who
 * it belongs to, which certificate it presents.
 *
 * The reading is made **by the worker**, on demand (`domain:inspect`): it opens
 * sockets — DNS, RDAP, TLS — and the panel does not open any. It is not kept: it
 * is a snapshot, taken again at each opening of the drawer.
 *
 * Error messages are the network's (`getaddrinfo ENOTFOUND`,
 * `certificate has expired`), as is: technical, and more useful that way than an
 * approximate translation. The states are codes the screen puts into words.
 */

const ADDRESS_SCOPES = [
  'public',
  'loopback',
  'private',
  'unique-local',
  'cgnat',
  'link-local',
  'multicast',
  'reserved',
  'unspecified',
] as const;

export const domainInspectionSchema = z.object({
  hostname: z.string(),
  checkedAt: z.string(),
  /** The resolution of the name itself, seen from the worker. */
  dns: z.object({
    status: z.enum(['ok', 'not_found', 'error']),
    error: z.string().nullable(),
    cname: z.array(z.string()),
    a: z.array(z.string()),
    aaaa: z.array(z.string()),
    /** The smallest TTL of the A/AAAA records: the time a fix takes to show. */
    ttl: z.number().nullable(),
  }),
  /** The registered domain's zone: its name servers, its mail, its CAA. */
  zone: z
    .object({
      name: z.string(),
      ns: z.array(z.string()),
      mx: z.array(z.string()),
      caa: z.array(z.string()),
    })
    .nullable(),
  addresses: z.array(
    z.object({
      address: z.string(),
      family: z.union([z.literal(4), z.literal(6)]),
      scope: z.enum(ADDRESS_SCOPES).nullable(),
      /** Reverse names (PTR). */
      reverse: z.array(z.string()),
    }),
  ),
  /** Does the name lead to the proxy that serves it? */
  pointing: z.object({
    status: z.enum(['match', 'mismatch', 'unknown']),
    /** The addresses of the proxy's machine, as resolved. */
    expected: z.array(z.string()),
  }),
  /** The domain's registration, through RDAP (structured "whois"). */
  registration: z.object({
    status: z.enum(['ok', 'not_found', 'local', 'unsupported', 'error']),
    /** The registered domain queried: `example.com` for `app.example.com`. */
    domain: z.string().nullable(),
    server: z.string().nullable(),
    error: z.string().nullable(),
    registrar: z.string().nullable(),
    registeredOn: z.string().nullable(),
    expiresOn: z.string().nullable(),
    lastChangedOn: z.string().nullable(),
    daysRemaining: z.number().nullable(),
    nameservers: z.array(z.string()),
    statuses: z.array(z.string()),
  }),
  certificate: z.object({
    /** `http`: the route does not serve TLS; `blocked`: an address the worker does not reach. */
    status: z.enum(['ok', 'http', 'blocked', 'error']),
    error: z.string().nullable(),
    address: z.string().nullable(),
    /** Is the chain recognized by the worker's authorities? */
    authorized: z.boolean().nullable(),
    authorizationError: z.string().nullable(),
    subject: z.string().nullable(),
    issuer: z.string().nullable(),
    issuerOrganization: z.string().nullable(),
    altNames: z.array(z.string()),
    validFrom: z.string().nullable(),
    validTo: z.string().nullable(),
    daysRemaining: z.number().nullable(),
    serialNumber: z.string().nullable(),
    fingerprint256: z.string().nullable(),
    protocol: z.string().nullable(),
    cipher: z.string().nullable(),
  }),
});

export type DomainInspection = z.infer<typeof domainInspectionSchema>;

export const domainInspectJobDataSchema = z.object({
  routeId: z.string().uuid(),
});
export type DomainInspectJobData = z.infer<typeof domainInspectJobDataSchema>;

/**
 * The most common two-label public suffixes: under them, the registered domain
 * has three (`example.co.uk`). It is not the public suffix list — 9,000 entries
 * to settle a rare case —, and the queried domain is shown: a mistake shows.
 */
const TWO_LABEL_SUFFIXES: ReadonlySet<string> = new Set([
  'co.uk',
  'org.uk',
  'me.uk',
  'ltd.uk',
  'plc.uk',
  'net.uk',
  'ac.uk',
  'gov.uk',
  'com.au',
  'net.au',
  'org.au',
  'edu.au',
  'gov.au',
  'co.nz',
  'org.nz',
  'net.nz',
  'co.jp',
  'ne.jp',
  'or.jp',
  'com.br',
  'net.br',
  'org.br',
  'com.mx',
  'com.ar',
  'com.tr',
  'com.cn',
  'com.hk',
  'com.sg',
  'com.tw',
  'co.za',
  'co.in',
  'co.kr',
  'co.il',
  'asso.fr',
  'nom.fr',
  'com.fr',
  'tm.fr',
  'gouv.fr',
  'com.es',
  'com.pl',
  'com.pt',
  'co.it',
]);

/**
 * The names no registry knows: `localhost`, the TLDs reserved for testing and
 * private networks (RFC 2606, 6761, 6762, 8375).
 */
const LOCAL_SUFFIXES = [
  'localhost',
  'test',
  'example',
  'invalid',
  'local',
  'internal',
  'lan',
  'home.arpa',
  'intranet',
  'corp',
  'home',
];

export function isLocalHostname(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/\.$/, '');
  return LOCAL_SUFFIXES.some((suffix) => name === suffix || name.endsWith(`.${suffix}`));
}

/** A name's registered domain: `example.com` for `app.example.com`. */
export function registrableDomainOf(hostname: string): string | null {
  const labels = hostname.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  if (labels.length < 2) return null;
  const lastTwo = labels.slice(-2).join('.');
  const count = TWO_LABEL_SUFFIXES.has(lastTwo) ? 3 : 2;
  if (labels.length < count) return null;
  return labels.slice(-count).join('.');
}
