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
import type { MonitorProbe, ProbeContext } from './types.js';

/**
 * Sonde d'expiration de domaine, **par RDAP**.
 *
 * ── RDAP et pas WHOIS ───────────────────────────────────────────────────────
 * Décision déjà prise, et elle tient en une phrase : RDAP rend du JSON dont la
 * forme est spécifiée (RFC 9083), WHOIS rend du texte libre dont le format
 * change d'un registre à l'autre. Écrire un analyseur WHOIS, c'est écrire
 * quarante analyseurs et se tromper sur le quarante-et-unième — au moment
 * précis où le mensonge coûte le plus cher, puisqu'on parle de la date à
 * laquelle un domaine disparaît.
 *
 * ── Trouver le bon serveur ──────────────────────────────────────────────────
 * L'IANA publie la liste d'amorçage `dns.json` : TLD → serveur RDAP. Les deux
 * extrêmes sont mauvais. La chercher à chaque interrogation, c'est 71 kio et un
 * aller-retour pour lire une date qui bouge une fois par an. L'embarquer en dur,
 * c'est la périmer : de nouveaux TLD apparaissent, des registres déménagent.
 *
 * D'où : **cache en mémoire, une semaine**, remplie paresseusement au premier
 * besoin ; en cas d'échec réseau, **une amorce embarquée** couvrant les TLD
 * qu'une instance a des chances de surveiller, et un cache d'échec de dix
 * minutes pour ne pas marteler l'IANA. Un worker fait donc *une* requête
 * d'amorçage par semaine, et continue de fonctionner sans elle.
 *
 * ── La garde SSRF, qui n'est pas la même que pour les autres sondes ─────────
 * Les autres sondes joignent une cible **que l'opérateur a choisie**, d'où
 * l'existence de `MONITOR_ALLOWED_CIDRS` : c'est lui qui décide quelles plages
 * internes son panel a le droit d'atteindre.
 *
 * Ici, personne n'a choisi la destination. L'opérateur saisit `exemple.fr` ; le
 * serveur joint est celui qu'un fichier tiers désigne, résolu par un DNS qui
 * peut mentir. Faire hériter cette requête de la liste d'autorisation reviendrait
 * à dire : « une entrée d'amorçage empoisonnée peut atteindre mon 10.0.0.0/8 ».
 * Donc **`PUBLIC_ONLY`** : adresses publiques uniquement, quelle que soit la
 * configuration du panel. Un registre est sur l'internet public par définition ;
 * s'il résout vers une adresse privée, c'est une attaque, pas une exception à
 * accommoder. Même règle pour la liste d'amorçage elle-même, dont l'URL est en
 * dur ici et jamais dérivée d'une saisie.
 *
 * S'y ajoute `requireHttps` : une réponse RDAP altérée en transit dirait
 * n'importe quoi sur une date d'expiration, et le seul coût de l'exiger est de
 * refuser des registres qui n'existent pas — la liste d'amorçage ne publie que
 * des URL `https`.
 */

// ─── liste d'amorçage ─────────────────────────────────────────────────────────

const IANA_BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';

/** Une semaine : la liste bouge de quelques entrées par mois, pas par heure. */
const BOOTSTRAP_TTL_MS = 7 * 86_400_000;
/** Après un échec, on retente dans dix minutes — pas à chaque sonde. */
const BOOTSTRAP_RETRY_MS = 10 * 60_000;
const BOOTSTRAP_TIMEOUT_MS = 15_000;

/**
 * Amorce de secours. **Ce n'est pas une copie de la liste de l'IANA** — la
 * copier serait la périmer en 71 kio. C'est le strict nécessaire pour qu'une
 * instance sans accès à `data.iana.org` continue de surveiller les domaines
 * qu'on surveille en pratique : les gTLD courants et les TLD francophones.
 * Relevé sur la liste du 2026-09-09.
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

/** La forme de `dns.json`, telle que la RFC 9224 la décrit. */
const bootstrapSchema = z.object({
  services: z.array(z.tuple([z.array(z.string()), z.array(z.string())])),
});

/** TLD → URL de base, à partir du document d'amorçage. */
export function readBootstrap(payload: unknown): Map<string, string> {
  const parsed = bootstrapSchema.safeParse(payload);
  const map = new Map<string, string>();
  if (!parsed.success) return map;
  for (const [tlds, urls] of parsed.data.services) {
    // On retient la première URL https : la liste en propose parfois deux, et
    // une réponse RDAP en clair ne se vérifie pas.
    const base = urls.find((url) => url.startsWith('https://'));
    if (base === undefined) continue;
    for (const tld of tlds) map.set(tld.toLowerCase(), base.endsWith('/') ? base : `${base}/`);
  }
  return map;
}

type BootstrapCache = { map: Map<string, string> | null; until: number };
let cache: BootstrapCache = { map: null, until: 0 };

/** Pour les tests et le harnais : repartir d'un cache vide. */
export function resetRdapBootstrapCache(): void {
  cache = { map: null, until: 0 };
}

async function bootstrapMap(): Promise<Map<string, string> | null> {
  if (Date.now() < cache.until) return cache.map;

  const result = await guardedFetch({
    url: IANA_BOOTSTRAP_URL,
    method: 'GET',
    timeoutMs: BOOTSTRAP_TIMEOUT_MS,
    // 71 kio au 2026-09-09 ; le plafond commun laisse de la marge sans
    // permettre à data.iana.org de nous servir un flux sans fin.
    maxBytes: MONITOR_MAX_RESPONSE_BYTES,
    readBody: true,
    allowlist: PUBLIC_ONLY,
    requireHttps: true,
    accept: 'application/json',
  });

  if (!result.ok || result.status !== 200 || result.truncated) {
    // Échec mis en cache aussi : sinon cinquante sondes de domaine retentent
    // chacune, toutes les six heures, un service qui ne répond pas.
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

/** Le serveur RDAP d'un TLD : la liste de l'IANA d'abord, l'amorce ensuite. */
export async function rdapEndpointFor(tld: string): Promise<RdapEndpoint | null> {
  const key = tld.toLowerCase();
  const live = await bootstrapMap();
  const fromIana = live?.get(key);
  if (fromIana !== undefined) return { base: fromIana, source: 'iana' };
  const seeded = BOOTSTRAP_SEED.get(key);
  return seeded === undefined ? null : { base: seeded, source: 'seed' };
}

// ─── lecture d'une réponse RDAP ───────────────────────────────────────────────

export type RdapDomainFacts = {
  ldhName: string | null;
  /** ISO 8601, tel que le registre l'écrit. `null` si le registre ne le publie pas. */
  expiresOn: string | null;
  registeredOn: string | null;
  lastChangedOn: string | null;
  registrar: string | null;
  nameservers: string[];
  /** Statuts EPP, normalisés en minuscules sans espaces ni tirets. */
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
 * Le nom lisible d'une entité, dans son vCard. La forme jCard est un tableau
 * de tableaux (`['fn', {}, 'text', 'OVH SAS']`) qu'aucun schéma Zod ne décrit
 * élégamment : on la parcourt à la main plutôt que de prétendre le contraire.
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
 * Les faits, extraits d'une réponse RDAP. Fonction **pure** : c'est elle que
 * les tests éprouvent sur des réponses réelles figées, sans réseau.
 *
 * Elle est délibérément tolérante. Les registres ne remplissent pas tous les
 * mêmes champs — `.com` majuscule son `ldhName` et publie trois statuts EPP,
 * `.fr` minuscule le sien et n'annonce souvent qu'`active` — et un champ absent
 * n'est pas une réponse invalide. Ce qui manque vaut `null` ; ce qui manque
 * *vraiment* (la date d'expiration) est traité par le verdict, pas ici.
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
    // « client transfer prohibited » (RFC 9083) et « clientTransferProhibited »
    // (forme EPP brute) désignent la même chose ; on aplatit les deux.
    statuses: (data.status ?? []).map((status) => status.toLowerCase().replace(/[\s_-]+/g, '')),
  };
}

// ─── verdict ──────────────────────────────────────────────────────────────────

export const DAY_MS = 86_400_000;

export function daysUntil(iso: string, now: Date): number {
  return Math.floor((new Date(iso).getTime() - now.getTime()) / DAY_MS);
}

function frenchDate(iso: string): string {
  const [date] = iso.split('T');
  const parts = (date ?? iso).split('-');
  return parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : iso;
}

export type DomainVerdict = {
  outcome: 'healthy' | 'unhealthy';
  detail: string | null;
  daysRemaining: number | null;
};

/**
 * Le jugement, séparé de la requête pour être éprouvable sur des fixtures.
 *
 * ── « Expire bientôt » dans une machine à états qui n'a que trois cases ─────
 * `healthy / unhealthy / unreachable`. Un domaine qui expire dans douze jours
 * n'est en panne d'aucune de ces façons : il est *en danger*. Aucune des trois
 * ne le dit, et il n'y en a pas de quatrième — en ajouter une toucherait le
 * verdict, la colonne `health_status`, le voyant de l'écran et une migration.
 *
 * On garde donc `unhealthy`, exactement comme la sonde TLS l'a déjà tranché
 * pour son préavis, et **la phrase porte la vérité que l'état ne porte pas** :
 * « expire dans 12 jours (le 25/09/2026) — sous le préavis de 30 jours ». Le
 * mot juste est dans le détail et dans `uptimeMeans` ; l'état, lui, ne sait dire
 * que « il faut s'en occuper ». C'est un compromis, et il est signalé comme tel
 * plutôt que maquillé.
 *
 * Plusieurs constats peuvent tomber ensemble — une expiration proche *et* un
 * registrar changé. On les rend tous : n'en dire qu'un ferait disparaître
 * l'autre du message d'alerte, et le second est souvent le plus grave.
 */
export function judgeDomain(
  facts: RdapDomainFacts,
  config: DomainConfig,
  now: Date,
): DomainVerdict {
  const problems: string[] = [];
  const notes: string[] = [];

  const daysRemaining = facts.expiresOn === null ? null : daysUntil(facts.expiresOn, now);

  if (facts.expiresOn === null || daysRemaining === null) {
    // Le registre a répondu et connaît le domaine : il *est* enregistré. Ne pas
    // publier de date n'est pas une panne, c'est une limite de ce registre — et
    // la taire serait laisser croire qu'on surveille l'expiration.
    notes.push("ce registre ne publie pas de date d'expiration");
  } else if (daysRemaining < 0) {
    problems.push(
      `domaine expiré depuis ${-daysRemaining} jour${daysRemaining < -1 ? 's' : ''} ` +
        `(le ${frenchDate(facts.expiresOn)})`,
    );
  } else if (daysRemaining < config.warnDays) {
    problems.push(
      `expire dans ${daysRemaining} jour${daysRemaining > 1 ? 's' : ''} ` +
        `(le ${frenchDate(facts.expiresOn)}) — sous le préavis de ${config.warnDays} jours`,
    );
  }

  if (config.expectedRegistrar !== null) {
    const expected = foldForSearch(config.expectedRegistrar);
    const actual = facts.registrar === null ? null : foldForSearch(facts.registrar);
    if (actual === null) {
      notes.push("ce registre ne publie pas de registrar — la comparaison n'a pas pu se faire");
    } else if (!actual.includes(expected)) {
      problems.push(
        `registrar « ${facts.registrar} », « ${config.expectedRegistrar} » attendu — ` +
          'un transfert de domaine ressemble exactement à ça',
      );
    }
  }

  if (config.expectedNameserverSuffix !== null) {
    const suffix = config.expectedNameserverSuffix.toLowerCase().replace(/^\.|\.$/g, '');
    if (facts.nameservers.length === 0) {
      notes.push('ce registre ne publie pas les serveurs de noms');
    } else if (!facts.nameservers.some((name) => name === suffix || name.endsWith(`.${suffix}`))) {
      problems.push(
        `aucun serveur de noms ne finit par « ${suffix} » — ` +
          `délégation actuelle : ${facts.nameservers.join(', ')}`,
      );
    }
  }

  if (config.transferLock === 'required') {
    const locked = facts.statuses.some(
      (status) => status === 'clienttransferprohibited' || status === 'servertransferprohibited',
    );
    if (!locked) {
      problems.push(
        'le verrou de transfert n’est pas annoncé' +
          (facts.statuses.length === 0
            ? ' (ce registre ne publie aucun statut)'
            : ` (statuts : ${facts.statuses.join(', ')})`),
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

// ─── la sonde ─────────────────────────────────────────────────────────────────

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

async function runDomain(config: DomainConfig): Promise<CheckResult> {
  const tld = tldOf(config.domain);
  const endpoint = await rdapEndpointFor(tld);

  if (endpoint === null) {
    // Normalement impossible : le catalogue refuse à la création les TLD dont
    // on sait qu'ils n'ont pas de RDAP. On y arrive quand même si la liste
    // d'amorçage est injoignable *et* que le TLD n'est pas dans l'amorce, ou
    // pour un `xn--` que le catalogue laisse passer faute de trancher.
    const known = tldPublishesRdap(tld);
    return {
      outcome: 'unreachable',
      latencyMs: null,
      detail:
        known === false
          ? `le TLD « .${tld} » ne publie pas de service RDAP — cette sonde ne peut rien y constater, ` +
            'et un domaine sans RDAP n’est pas un domaine en panne : mieux vaut la supprimer'
          : `aucun serveur RDAP connu pour « .${tld} » — liste d’amorçage de l’IANA injoignable ` +
            'et TLD absent de l’amorce embarquée',
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
    // Adresses publiques uniquement : voir l'en-tête de ce fichier. Le serveur
    // n'est pas choisi par l'opérateur, il n'hérite donc pas de ses ouvertures.
    allowlist: PUBLIC_ONLY,
    requireHttps: true,
    accept: 'application/rdap+json, application/json',
  });

  if (!result.ok) {
    return {
      outcome: 'unreachable',
      latencyMs: null,
      detail: `registre ${server} : ${result.detail}`,
      metrics: emptyMetrics(server),
    };
  }

  if (result.status === 404) {
    // Le seul cas où le registre nous dit vraiment quelque chose de mauvais sur
    // le domaine : il ne le connaît pas. Soit il a expiré et a été purgé, soit
    // ce n'est pas le nom enregistré — un sous-domaine, typiquement.
    return {
      outcome: 'unhealthy',
      latencyMs: result.latencyMs,
      detail:
        `le registre ${server} ne connaît pas « ${config.domain} » — ` +
        'domaine expiré et purgé, ou nom qui n’est pas celui qui est enregistré ' +
        '(« exemple.fr », pas « www.exemple.fr »)',
      metrics: { ...emptyMetrics(server), latencyMs: result.latencyMs },
    };
  }

  if (result.status !== 200) {
    // 429, 5xx, page d'erreur HTML… : le registre va mal, pas le domaine.
    return {
      outcome: 'unreachable',
      latencyMs: result.latencyMs,
      detail: `le registre ${server} a répondu ${result.status} — c’est le registre, pas le domaine`,
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
      detail: `réponse illisible du registre ${server} — ce n’est pas du JSON RDAP`,
      metrics: { ...emptyMetrics(server), latencyMs: result.latencyMs },
    };
  }

  const facts = readRdapDomain(payload);
  const verdict = judgeDomain(facts, config, new Date());

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
  async run(config, _ctx: ProbeContext): Promise<CheckResult> {
    const parsed = domainConfigSchema.safeParse(config);
    if (!parsed.success) {
      return {
        outcome: 'unreachable',
        latencyMs: null,
        detail: `configuration de sonde invalide : ${parsed.error.issues.map((issue) => issue.message).join(', ')}`,
        metrics: {},
      };
    }
    return runDomain(parsed.data);
  },
};
