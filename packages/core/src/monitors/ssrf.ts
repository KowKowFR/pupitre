import { z } from 'zod';

/**
 * ⚠ Politique SSRF de la supervision.
 *
 * Le risque, énoncé franchement : cette fonctionnalité fait qu'un serveur va
 * chercher une cible **fournie par un utilisateur**. C'est une SSRF par
 * construction. Quelqu'un qui peut créer une sonde pourrait faire émettre au
 * worker une requête vers `http://localhost:5432`, vers `10.0.0.0/8`, ou vers
 * `169.254.169.254` — le service de métadonnées d'un cloud, qui rend des
 * identifiants.
 *
 * ── La décision ──────────────────────────────────────────────────────────────
 *
 * 1. **Schéma** : `http` et `https` seulement. Pas de `file:`, `gopher:`,
 *    `ftp:`, ni d'URL portant des identifiants (`user:pass@`).
 *
 * 2. **Adresses** : tout est refusé sauf le public. Un blocage *total* des
 *    adresses privées serait absurde — ce panel supervise précisément des
 *    machines internes. L'ouverture se fait donc par une **liste
 *    d'autorisation de CIDR**, `MONITOR_ALLOWED_CIDRS`, lue dans
 *    l'environnement du panel et du worker.
 *
 *    Pourquoi l'environnement, et non un réglage d'instance ni une permission ?
 *    Parce qu'une permission serait un leurre : `monitor:manage` est justement
 *    ce que porte quiconque crée une sonde ; lui donner en plus le droit de
 *    lever la garde revient à ne pas avoir de garde. « Quelles plages internes
 *    ce panel a-t-il le droit d'atteindre » est une décision de **déploiement**,
 *    prise par qui tient le `.env` — au même endroit que `MASTER_KEY` et que
 *    `DRIVER_PORT_RANGE`. Personne ne l'élargit depuis l'interface.
 *
 * 3. **Jamais autorisables**, quelle que soit la liste : le lien-local
 *    (`169.254.0.0/16`, `fe80::/10`) qui porte les services de métadonnées, le
 *    multicast, le réservé, et l'adresse indéterminée. Un service de métadonnées
 *    n'est pas un site à superviser, c'est un distributeur de jetons.
 *
 * 4. **Redirections** : contrôler l'adresse de départ ne suffit pas — une URL
 *    publique peut renvoyer un 302 vers `http://169.254.169.254`. Chaque saut
 *    est donc re-résolu et re-contrôlé, et il y en a cinq au plus.
 *
 * 5. **Rebinding DNS** : la sonde résout le nom une fois, contrôle *toutes* les
 *    adresses rendues, puis se connecte à l'adresse retenue **en littéral**,
 *    avec l'en-tête `Host` et le SNI du nom d'origine. Il n'y a donc pas de
 *    seconde résolution entre le contrôle et la connexion : la fenêtre de
 *    TOCTOU est fermée.
 *
 * 6. **Taille de réponse** bornée, délai borné.
 *
 * 7. **Les requêtes vers un tiers que l'opérateur n'a pas choisi n'héritent pas
 *    de la liste d'autorisation.** La sonde d'expiration de domaine ne joint pas
 *    la cible : elle joint le serveur RDAP d'un registre, désigné par la liste
 *    d'amorçage de l'IANA. Personne dans ce panel n'a décidé de cette adresse.
 *
 *    Or `MONITOR_ALLOWED_CIDRS` répond à une question précise — « quelles plages
 *    internes ce panel a-t-il le droit d'atteindre *pour superviser le parc de
 *    l'opérateur* » — et pas à « quelles plages un tiers a le droit de nous faire
 *    joindre ». Faire hériter la requête RDAP de cette ouverture reviendrait à
 *    accepter qu'une entrée d'amorçage erronée, ou un DNS empoisonné, fasse
 *    entrer une requête sortante dans le 10.0.0.0/8 de l'opérateur — et il
 *    l'aurait autorisée sans jamais l'avoir voulu.
 *
 *    Ces appels passent donc `PUBLIC_ONLY` (`probe/fetch.ts`) : adresses
 *    publiques seulement, quelle que soit la configuration. Un registre est sur
 *    l'internet public par définition ; s'il résout vers une adresse privée,
 *    c'est une anomalie à refuser, pas une exception à accommoder. La règle vaut
 *    aussi pour la liste d'amorçage elle-même, dont l'URL est en dur et jamais
 *    dérivée d'une saisie, et s'accompagne d'une exigence d'`https` : une
 *    réponse RDAP altérée en transit dirait n'importe quoi sur une date
 *    d'expiration.
 *
 * Cette politique vaut pour **tous** les types de sonde, présents et à venir —
 * HTTP, mot-clé, TLS, RDAP, et demain DNS. Elle vit ici, à part du catalogue,
 * pour qu'aucune implémentation n'ait à la réécrire ni la possibilité de
 * l'oublier ; la boucle de requête qui l'applique vit en un seul exemplaire
 * dans `probe/fetch.ts`, pour la même raison.
 *
 * ── Ce qui reste ouvert, et qui est assumé ───────────────────────────────────
 * Une plage autorisée l'est pour toutes les sondes : il n'y a pas de
 * granularité par utilisateur. Et une sonde autorisée sur une plage interne
 * peut servir de scanner de ports lent (le code de réponse et la latence
 * fuitent). C'est le prix de superviser un parc interne ; la liste
 * d'autorisation est là pour que ce prix soit payé sciemment, sur des plages
 * nommées.
 */

export type AddressCategory =
  | 'public'
  | 'loopback'
  | 'private'
  | 'unique-local'
  | 'cgnat'
  | 'link-local'
  | 'multicast'
  | 'reserved'
  | 'unspecified';

/** Catégories qu'aucune liste d'autorisation ne peut débloquer. */
const NEVER_ALLOWED: ReadonlySet<AddressCategory> = new Set<AddressCategory>([
  'link-local',
  'multicast',
  'reserved',
  'unspecified',
]);

const CATEGORY_LABEL: Record<AddressCategory, string> = {
  public: 'publique',
  loopback: 'de bouclage',
  private: 'privée',
  'unique-local': 'locale unique (IPv6)',
  cgnat: 'de NAT opérateur',
  'link-local': 'de lien local — ce sont les services de métadonnées',
  multicast: 'de multidiffusion',
  reserved: 'réservée',
  unspecified: 'indéterminée',
};

/** Une adresse, normalisée en octets. 4 pour IPv4, 16 pour IPv6. */
export type IpAddress = { bytes: number[]; family: 4 | 6 };

export function parseIpv4(value: string): IpAddress | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    // `01` et `1e2` ne sont pas des octets : on n'accepte que la forme décimale
    // canonique, sans quoi `0177.0.0.1` (octal) contournerait le contrôle.
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith('0')) return null;
    const byte = Number(part);
    if (byte > 255) return null;
    bytes.push(byte);
  }
  return { bytes, family: 4 };
}

export function parseIpv6(value: string): IpAddress | null {
  // Le suffixe de zone (`fe80::1%eth0`) ne change pas l'adresse.
  const raw = value.split('%')[0] ?? value;
  if (!raw.includes(':')) return null;

  const doubleColon = raw.indexOf('::');
  if (doubleColon !== raw.lastIndexOf('::')) return null;

  const [headText, tailText] =
    doubleColon >= 0 ? [raw.slice(0, doubleColon), raw.slice(doubleColon + 2)] : [raw, null];

  const readGroups = (text: string): number[][] | null => {
    if (text === '') return [];
    const groups: number[][] = [];
    const tokens = text.split(':');
    for (const [index, token] of tokens.entries()) {
      if (token.includes('.')) {
        // Forme mixte `::ffff:127.0.0.1` — seulement en dernière position.
        if (index !== tokens.length - 1) return null;
        const embedded = parseIpv4(token);
        if (!embedded) return null;
        groups.push([embedded.bytes[0] ?? 0, embedded.bytes[1] ?? 0]);
        groups.push([embedded.bytes[2] ?? 0, embedded.bytes[3] ?? 0]);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(token)) return null;
      const word = Number.parseInt(token, 16);
      groups.push([(word >> 8) & 0xff, word & 0xff]);
    }
    return groups;
  };

  const head = readGroups(headText);
  if (head === null) return null;
  const tail = tailText === null ? [] : readGroups(tailText);
  if (tail === null) return null;

  if (tailText === null) {
    if (head.length !== 8) return null;
    return { bytes: head.flat(), family: 6 };
  }

  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  const filler: number[][] = Array.from({ length: missing }, () => [0, 0]);
  return { bytes: [...head, ...filler, ...tail].flat(), family: 6 };
}

export function parseIp(value: string): IpAddress | null {
  const trimmed = value.trim().replace(/^\[|\]$/g, '');
  return parseIpv4(trimmed) ?? parseIpv6(trimmed);
}

function inRange(bytes: number[], prefix: number[], bits: number): boolean {
  let remaining = bits;
  for (let index = 0; remaining > 0; index += 1) {
    const take = Math.min(8, remaining);
    const mask = take === 8 ? 0xff : (0xff << (8 - take)) & 0xff;
    if (((bytes[index] ?? 0) & mask) !== ((prefix[index] ?? 0) & mask)) return false;
    remaining -= take;
  }
  return true;
}

/**
 * Une adresse IPv6 qui encapsule de l'IPv4 doit être jugée sur l'IPv4 qu'elle
 * transporte — sinon `::ffff:127.0.0.1` passerait pour une IPv6 quelconque.
 */
function unwrapIpv4(address: IpAddress): IpAddress {
  if (address.family !== 6) return address;
  const { bytes } = address;
  const v4 = { bytes: bytes.slice(12), family: 4 as const };
  // `::ffff:a.b.c.d` — la forme mappée, de loin la plus courante.
  if (inRange(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], 96)) return v4;
  // `64:ff9b::/96` — traduction NAT64.
  if (inRange(bytes, [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0], 96)) return v4;
  // `::a.b.c.d` — IPv4-compatible, obsolète mais encore acceptée par les piles.
  // `bytes[12] !== 0` écarte `::1`, qui est du vrai IPv6 de bouclage.
  if (bytes.slice(0, 12).every((byte) => byte === 0) && bytes[12] !== 0) return v4;
  return address;
}

export function classifyAddress(value: string): AddressCategory | null {
  const parsed = parseIp(value);
  if (!parsed) return null;
  const address = unwrapIpv4(parsed);
  const { bytes, family } = address;

  if (family === 4) {
    if (inRange(bytes, [0, 0, 0, 0], 8)) return 'unspecified';
    if (inRange(bytes, [127, 0, 0, 0], 8)) return 'loopback';
    if (inRange(bytes, [10, 0, 0, 0], 8)) return 'private';
    if (inRange(bytes, [172, 16, 0, 0], 12)) return 'private';
    if (inRange(bytes, [192, 168, 0, 0], 16)) return 'private';
    if (inRange(bytes, [169, 254, 0, 0], 16)) return 'link-local';
    if (inRange(bytes, [100, 64, 0, 0], 10)) return 'cgnat';
    if (inRange(bytes, [192, 0, 0, 0], 24)) return 'reserved';
    if (inRange(bytes, [192, 0, 2, 0], 24)) return 'reserved';
    if (inRange(bytes, [198, 18, 0, 0], 15)) return 'reserved';
    if (inRange(bytes, [198, 51, 100, 0], 24)) return 'reserved';
    if (inRange(bytes, [203, 0, 113, 0], 24)) return 'reserved';
    if (inRange(bytes, [224, 0, 0, 0], 4)) return 'multicast';
    if (inRange(bytes, [240, 0, 0, 0], 4)) return 'reserved';
    return 'public';
  }

  if (bytes.every((byte) => byte === 0)) return 'unspecified';
  if (inRange(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], 128)) return 'loopback';
  if (inRange(bytes, [0xfe, 0x80], 10)) return 'link-local';
  if (inRange(bytes, [0xfc], 7)) return 'unique-local';
  if (inRange(bytes, [0xff], 8)) return 'multicast';
  if (inRange(bytes, [0x20, 0x01, 0x00, 0x00], 32)) return 'reserved'; // Teredo
  if (inRange(bytes, [0x20, 0x01, 0x0d, 0xb8], 32)) return 'reserved'; // documentation
  return 'public';
}

// ─── liste d'autorisation ─────────────────────────────────────────────────────

export type Cidr = { address: IpAddress; bits: number; text: string };

export function parseCidr(value: string): Cidr | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const slash = trimmed.lastIndexOf('/');
  const hostPart = slash >= 0 ? trimmed.slice(0, slash) : trimmed;
  const address = parseIp(hostPart);
  if (!address) return null;

  const maxBits = address.family === 4 ? 32 : 128;
  if (slash < 0) return { address, bits: maxBits, text: `${hostPart}/${maxBits}` };

  const bitsText = trimmed.slice(slash + 1);
  if (!/^\d{1,3}$/.test(bitsText)) return null;
  const bits = Number(bitsText);
  if (bits > maxBits) return null;
  return { address, bits, text: trimmed };
}

/** `MONITOR_ALLOWED_CIDRS` : des CIDR séparés par des virgules. Vide = rien d'ouvert. */
export function parseCidrList(value: string | undefined): Cidr[] {
  if (!value) return [];
  const out: Cidr[] = [];
  for (const token of value.split(',')) {
    const cidr = parseCidr(token);
    if (cidr) out.push(cidr);
  }
  return out;
}

export function cidrContains(cidr: Cidr, address: IpAddress): boolean {
  const target = unwrapIpv4(address);
  const base = unwrapIpv4(cidr.address);
  if (base.family !== target.family) return false;
  // Un CIDR écrit en IPv6 mais qui encapsule de l'IPv4 garde ses bits de
  // préfixe exprimés sur 128 : on les ramène à l'échelle de l'IPv4.
  const bits =
    cidr.address.family === 6 && base.family === 4 ? Math.max(0, cidr.bits - 96) : cidr.bits;
  return inRange(target.bytes, base.bytes, bits);
}

export type AddressVerdict =
  | { allowed: true; category: AddressCategory; via: string | null }
  | { allowed: false; category: AddressCategory | null; reason: string };

/** Le contrôle d'une adresse, une fois résolue. Point d'entrée unique. */
export function checkAddress(value: string, allowlist: readonly Cidr[]): AddressVerdict {
  const parsed = parseIp(value);
  const category = parsed ? classifyAddress(value) : null;
  if (!parsed || category === null) {
    return { allowed: false, category: null, reason: `adresse illisible « ${value} »` };
  }
  if (category === 'public') return { allowed: true, category, via: null };

  if (NEVER_ALLOWED.has(category)) {
    return {
      allowed: false,
      category,
      reason:
        `${value} est une adresse ${CATEGORY_LABEL[category]} — ` +
        "elle ne peut être autorisée par aucune liste, c'est une règle du panel",
    };
  }

  const match = allowlist.find((cidr) => cidrContains(cidr, parsed));
  if (match) return { allowed: true, category, via: match.text };

  return {
    allowed: false,
    category,
    reason:
      `${value} est une adresse ${CATEGORY_LABEL[category]} et n'appartient à aucune plage ` +
      'autorisée — ajouter la plage à MONITOR_ALLOWED_CIDRS pour la superviser',
  };
}

/** Contrôle d'un nom d'hôte, avant toute résolution. */
export function checkHostname(hostname: string): { allowed: boolean; reason?: string } {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (host === '') return { allowed: false, reason: "la cible n'a pas de nom d'hôte" };
  // `localhost` ne résout pas toujours en 127.0.0.1 ; on le refuse par son nom
  // en plus de son adresse, pour que le message soit clair.
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return { allowed: false, reason: '« localhost » ne se supervise pas depuis le worker' };
  }
  return { allowed: true };
}

/** Schéma, identifiants, nom d'hôte. La résolution DNS vient après, dans la sonde. */
export function checkUrlShape(value: string): { allowed: boolean; reason?: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { allowed: false, reason: `URL illisible « ${value} »` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      allowed: false,
      reason: `schéma « ${url.protocol.replace(':', '')} » refusé — http ou https uniquement`,
    };
  }
  if (url.username !== '' || url.password !== '') {
    return { allowed: false, reason: "une URL de sonde ne porte pas d'identifiants" };
  }
  return checkHostname(url.hostname);
}

/** URL de sonde : la forme est validée ici, les adresses au moment de sonder. */
export const monitorUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .superRefine((value, ctx) => {
    const verdict = checkUrlShape(value);
    if (!verdict.allowed) ctx.addIssue({ code: 'custom', message: verdict.reason ?? 'URL refusée' });
  });

/** Nom d'hôte de sonde — pour les types qui ne parlent pas HTTP (TLS, demain DNS). */
export const monitorHostSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .superRefine((value, ctx) => {
    if (value.includes('/') || value.includes(':')) {
      ctx.addIssue({ code: 'custom', message: "un nom d'hôte, sans schéma ni port" });
      return;
    }
    const verdict = checkHostname(value);
    if (!verdict.allowed) {
      ctx.addIssue({ code: 'custom', message: verdict.reason ?? 'hôte refusé' });
    }
  });
