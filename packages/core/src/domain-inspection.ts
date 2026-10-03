import { z } from 'zod';

/**
 * Ce que l'on sait d'un domaine quand on le regarde de près : où il pointe,
 * à qui il appartient, quel certificat il présente.
 *
 * Le relevé est fait **par le worker**, à la demande (`domain:inspect`) : il
 * ouvre des sockets — DNS, RDAP, TLS — et le panel n'en ouvre pas. Il n'est
 * pas gardé : c'est une photographie, refaite à chaque ouverture du tiroir.
 *
 * Les messages d'erreur sont ceux du réseau (`getaddrinfo ENOTFOUND`,
 * `certificate has expired`), tels quels : techniques, et plus utiles ainsi
 * qu'une traduction approximative. Les états, eux, sont des codes que l'écran
 * met en mots.
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
  /** La résolution du nom lui-même, vue du worker. */
  dns: z.object({
    status: z.enum(['ok', 'not_found', 'error']),
    error: z.string().nullable(),
    cname: z.array(z.string()),
    a: z.array(z.string()),
    aaaa: z.array(z.string()),
    /** Le plus petit TTL des A/AAAA : le temps qu'une correction met à se voir. */
    ttl: z.number().nullable(),
  }),
  /** La zone du domaine enregistré : ses serveurs de noms, son courrier, ses CAA. */
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
      /** Les noms inverses (PTR). */
      reverse: z.array(z.string()),
    }),
  ),
  /** Le nom mène-t-il au proxy qui le sert ? */
  pointing: z.object({
    status: z.enum(['match', 'mismatch', 'unknown']),
    /** Les adresses de la machine du proxy, telles que résolues. */
    expected: z.array(z.string()),
  }),
  /** L'enregistrement du domaine, par RDAP (le « whois » structuré). */
  registration: z.object({
    status: z.enum(['ok', 'not_found', 'local', 'unsupported', 'error']),
    /** Le domaine enregistré interrogé : `exemple.fr` pour `app.exemple.fr`. */
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
    /** `http` : la route ne sert pas de TLS ; `blocked` : adresse que le worker ne joint pas. */
    status: z.enum(['ok', 'http', 'blocked', 'error']),
    error: z.string().nullable(),
    address: z.string().nullable(),
    /** La chaîne est-elle reconnue par les autorités du worker ? */
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
 * Les suffixes publics à deux étiquettes les plus courants : sous eux, le
 * domaine enregistré en compte trois (`exemple.co.uk`). Ce n'est pas la
 * liste publique des suffixes — 9 000 entrées pour trancher un cas rare —, et
 * le domaine interrogé est affiché : une erreur se voit.
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
 * Les noms qu'aucun registre ne connaît : `localhost`, les TLD réservés aux
 * essais et aux réseaux privés (RFC 2606, 6761, 6762, 8375).
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

/** Le domaine enregistré d'un nom : `exemple.fr` pour `app.exemple.fr`. */
export function registrableDomainOf(hostname: string): string | null {
  const labels = hostname.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  if (labels.length < 2) return null;
  const lastTwo = labels.slice(-2).join('.');
  const count = TWO_LABEL_SUFFIXES.has(lastTwo) ? 3 : 2;
  if (labels.length < count) return null;
  return labels.slice(-count).join('.');
}
