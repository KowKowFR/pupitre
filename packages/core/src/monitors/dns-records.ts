import { z } from 'zod';
import type { UiLanguage } from '../i18n.js';
import { probeSay } from '../probe/messages.js';
import { parseIp } from './ssrf.js';
import { invalid, type ValidationRef } from '../validation.js';

/**
 * Le vocabulaire DNS, et **la comparaison de deux réponses DNS**.
 *
 * Fichier à part, et **pur** : ni `node:dns`, ni socket. La sonde DNS
 * (`@pupitre/core/probe`) interroge ; ce module dit ce qu'on attendait et ce
 * qu'on a obtenu. Le séparer permet de tester la partie difficile — la
 * comparaison — sans réseau, et permet au catalogue (importé par des composants
 * client) de valider une configuration sans tirer un module natif.
 *
 * ── Le piège, et c'est tout le sujet ────────────────────────────────────────
 * Un comparateur naïf sur des chaînes produirait une alerte par interrogation :
 *
 *   - **L'ordre n'est pas du signal.** Un résolveur permute délibérément les
 *     réponses d'un même RRset (round-robin) ; deux MX rendus dans un autre
 *     ordre, c'est le même DNS. On compare donc des **ensembles**, jamais des
 *     listes.
 *   - **La casse d'un *nom* n'est pas du signal.** RFC 4343 : les noms de
 *     domaine se comparent sans égard à la casse, et certains résolveurs
 *     renvoient volontairement une casse mélangée (0x20 encoding, une défense
 *     anti-empoisonnement). `Mail.Exemple.FR.` et `mail.exemple.fr` sont le
 *     même nom.
 *   - **La casse d'une *donnée* est du signal.** Et c'est la nuance que rate
 *     un « on met tout en minuscules » : la valeur d'un TXT est une chaîne
 *     arbitraire. Une clé DKIM est du base64, où `aB` et `Ab` sont deux clés
 *     différentes. Replier la casse d'un TXT ne créerait pas de fausse alerte —
 *     il créerait une **fausse égalité**, ce qui est bien pire pour une sonde
 *     censée détecter un détournement. Donc : casse repliée sur les noms, jamais
 *     sur les données.
 *   - **Le point final n'est pas du signal.** `exemple.fr.` et `exemple.fr`
 *     sont le même nom ; les outils les écrivent différemment.
 *   - **La forme d'écriture d'une adresse n'est pas du signal.**
 *     `2001:0db8:0000::1` et `2001:db8::1` sont la même adresse. On compare donc
 *     les **octets**, pas le texte.
 *
 * D'où la forme retenue : chaque valeur — attendue ou observée — est réduite à
 * une **clé de comparaison** canonique, et on compare des ensembles de clés. La
 * valeur d'origine est conservée pour l'affichage, parce qu'un message d'alerte
 * qui montre une clé hexadécimale n'aide personne.
 *
 * ── Ce que le préfixe de priorité fait ici ──────────────────────────────────
 * Un MX, c'est une priorité **et** un hôte : `10 mail1` puis `20 mail2` n'est
 * pas la même configuration que l'inverse — c'est le serveur de secours qui
 * devient le principal. La priorité entre donc dans la clé. Même chose pour
 * SRV, où poids et port décident où va vraiment le trafic.
 */

// ─── quels types d'enregistrement, et pourquoi pas les autres ─────────────────

/**
 * Les types retenus.
 *
 * Le critère n'est pas « ce qui existe » mais « ce dont la panne se constate de
 * l'extérieur et se répare » :
 *
 *   A / AAAA   où pointe le nom. La panne la plus fréquente et la plus totale.
 *   CNAME      l'alias — un CDN ou un SaaS qu'on a laissé filer se voit ici.
 *   MX         le courrier. Une erreur de MX ne se voit pas sur le site : rien
 *              ne casse visiblement, le courrier disparaît simplement.
 *   NS         la délégation. C'est **la** cible d'un détournement de domaine :
 *              qui change les NS change tout le reste sans qu'on le voie.
 *   TXT        SPF, DKIM, DMARC, et les preuves de propriété. Supprimer un TXT
 *              de vérification casse une intégration des semaines plus tard.
 *   CAA        qui a le droit d'émettre un certificat pour ce domaine. Un CAA
 *              qui disparaît, c'est la porte ouverte à une émission illégitime.
 *   SRV        les services qui se découvrent par le DNS (XMPP, SIP, LDAP,
 *              autodiscover). Peu utilisé, mais quand il l'est, c'est critique
 *              et invisible autrement.
 *
 * **SOA est écarté**, alors que tous les services commerciaux le proposent. Un
 * SOA porte un numéro de série qui **change à chaque modification de la zone** :
 * une sonde qui compare un SOA alerterait à chaque édition légitime, c'est-à-dire
 * exactement quand l'administrateur sait déjà ce qu'il fait. Et ce qu'un SOA
 * apprend d'utile — la zone existe-t-elle encore, qui en est le primaire — est
 * déjà porté par NS, qui lui ne bouge pas. Une sonde qui crie à chaque
 * changement normal finit ignorée, et c'est le pire état d'une supervision.
 *
 * **PTR est écarté** aussi : il s'interroge sur un nom `in-addr.arpa`, pas sur
 * un domaine, et il se configure chez l'hébergeur de l'adresse, pas chez le
 * titulaire du nom. Ce n'est pas le même objet, ni la même personne à prévenir.
 */
export const DNS_RECORD_TYPES_LIST = [
  'A',
  'AAAA',
  'CNAME',
  'MX',
  'NS',
  'TXT',
  'CAA',
  'SRV',
] as const;

export const dnsRecordTypeSchema = z.enum(DNS_RECORD_TYPES_LIST);
export type DnsRecordType = z.infer<typeof dnsRecordTypeSchema>;

// Ce que chaque type observe s'écrit dans le catalogue, aux clés `dns.record.*`
// de `monitorCatalogCopy` : c'est là que l'écran va le chercher, dans la langue
// de l'instance. La table qui vivait ici n'avait plus de lecteur.

/** La forme qu'une valeur attendue doit prendre. Affichée en aide de saisie. */
export const DNS_RECORD_TYPE_FORMATS: Record<DnsRecordType, string> = {
  A: '203.0.113.7',
  AAAA: '2001:db8::1',
  CNAME: 'cible.exemple.fr',
  MX: '10 mail.exemple.fr',
  NS: 'ns1.exemple.fr',
  TXT: 'v=spf1 include:_spf.exemple.fr ~all',
  CAA: '0 issue letsencrypt.org',
  SRV: '10 5 5269 xmpp.exemple.fr',
};

/** Les types dont la donnée est un nom de domaine — casse et point final indifférents. */
const NAME_VALUED: ReadonlySet<DnsRecordType> = new Set<DnsRecordType>(['CNAME', 'NS']);

// ─── canonicalisation ─────────────────────────────────────────────────────────

/** Un nom de domaine, réduit à ce qui le distingue : minuscules, sans point final. */
export function normalizeDnsName(value: string): string {
  return value.trim().replace(/\.+$/, '').toLowerCase();
}

/**
 * Une adresse, réduite à ses octets. C'est ce qui rend `2001:0db8:0000::1` et
 * `2001:db8::1` égales sans avoir à réimplémenter la compression IPv6.
 */
function addressKey(value: string): string | null {
  const parsed = parseIp(value.trim());
  if (!parsed) return null;
  return `${parsed.family}:${parsed.bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * `dig` rend une longue chaîne TXT en morceaux entre guillemets :
 * `"v=spf1 ..." "... ~all"`. Un humain colle ce qu'il voit ; on recolle donc les
 * morceaux, comme le fait un résolveur. Sans guillemets, la valeur est prise
 * telle quelle.
 */
export function joinTxtChunks(value: string): string {
  const quoted = [...value.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1] ?? '');
  if (quoted.length === 0) return value.trim();
  return quoted.join('').replace(/\\"/g, '"');
}

function tokens(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean);
}

/**
 * La **clé de comparaison** d'une valeur, attendue ou observée.
 *
 * Deux valeurs sont « le même enregistrement » si et seulement si leurs clés
 * sont identiques. Tout le reste du module ne fait que manipuler des ensembles
 * de clés.
 */
export function dnsComparisonKey(type: DnsRecordType, value: string): string {
  const raw = value.trim();

  if (type === 'A' || type === 'AAAA') {
    // Une valeur illisible garde une clé stable : elle ne correspondra à rien,
    // ce qui est le comportement voulu, et le message montrera le texte saisi.
    return addressKey(raw) ?? `?${raw.toLowerCase()}`;
  }

  if (NAME_VALUED.has(type)) return normalizeDnsName(raw);

  if (type === 'TXT') {
    // Aucun repli de casse : la donnée d'un TXT est arbitraire, et une clé DKIM
    // en base64 distingue `aB` de `Ab`.
    return joinTxtChunks(raw);
  }

  if (type === 'MX') {
    const parts = tokens(raw);
    const priority = parts.length > 1 && /^\d+$/.test(parts[0] ?? '') ? Number(parts[0]) : null;
    const host = priority === null ? parts.join(' ') : parts.slice(1).join(' ');
    return `${priority ?? '?'} ${normalizeDnsName(host)}`;
  }

  if (type === 'SRV') {
    const parts = tokens(raw);
    if (parts.length < 4) return `?${raw.toLowerCase()}`;
    const [priority, weight, port, ...rest] = parts;
    return `${Number(priority)} ${Number(weight)} ${Number(port)} ${normalizeDnsName(rest.join(' '))}`;
  }

  // CAA : `<drapeaux> <étiquette> <valeur>`. L'étiquette est insensible à la
  // casse (RFC 8659) ; la valeur est un nom d'autorité ou une URL de contact,
  // qu'on replie aussi — deux CA ne se distinguent pas par une majuscule.
  const parts = tokens(raw);
  if (parts.length < 3) return `?${raw.toLowerCase()}`;
  const [flags, tag, ...rest] = parts;
  const payload = joinTxtChunks(rest.join(' ')).trim().toLowerCase();
  return `${Number(flags)} ${(tag ?? '').toLowerCase()} ${payload}`;
}

// ─── saisie d'une liste attendue ──────────────────────────────────────────────

/**
 * Découpe le texte saisi en valeurs attendues.
 *
 * Le retour à la ligne sépare toujours. La virgule ne sépare que pour les types
 * dont la donnée ne peut pas en contenir : une virgule est parfaitement légale
 * dans un TXT (`v=spf1 ip4:a,ip4:b` chez certains), et couper dessus casserait
 * silencieusement la valeur attendue — le pire des bogues, celui qui produit
 * une alerte que personne ne comprend.
 */
export function parseExpectedRecords(type: DnsRecordType, text: string): string[] {
  const lines = text.split(/\r?\n/);
  const pieces = type === 'TXT' ? lines : lines.flatMap((line) => line.split(','));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const piece of pieces) {
    const value = piece.trim();
    if (value === '') continue;
    const key = dnsComparisonKey(type, value);
    // Deux écritures de la même valeur ne comptent qu'une fois, sinon un
    // « exactement ces valeurs » deviendrait insatisfiable.
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/** Contrôle de forme d'une valeur attendue. `null` = la forme est bonne. */
export function validateDnsRecordValue(type: DnsRecordType, value: string): string | null {
  const problem = dnsRecordProblem(type, value);
  return problem === null ? null : invalid(problem.key, problem.vars).message;
}

/** Le même contrôle, le reproche en donnée — pour un schéma. */
export function dnsRecordProblem(type: DnsRecordType, value: string): ValidationRef | null {
  const raw = value.trim();
  if (raw === '') return { key: 'dns.empty' };
  if (raw.length > 2048) return { key: 'dns.tooLong' };

  const isName = (candidate: string): boolean =>
    candidate.length > 0 &&
    candidate.length <= 253 &&
    /^(?:[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?)(?:\.(?:[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?))*\.?$/i.test(
      candidate,
    );

  switch (type) {
    case 'A': {
      const parsed = parseIp(raw);
      return parsed && parsed.family === 4 ? null : { key: 'dns.notIpv4', vars: { value: raw } };
    }
    case 'AAAA': {
      const parsed = parseIp(raw);
      return parsed && parsed.family === 6 ? null : { key: 'dns.notIpv6', vars: { value: raw } };
    }
    case 'CNAME':
    case 'NS':
      return isName(raw) ? null : { key: 'dns.notName', vars: { value: raw } };
    case 'MX': {
      const parts = tokens(raw);
      if (parts.length !== 2 || !/^\d{1,5}$/.test(parts[0] ?? '') || !isName(parts[1] ?? '')) {
        return { key: 'dns.mx', vars: { example: DNS_RECORD_TYPE_FORMATS.MX } };
      }
      return null;
    }
    case 'SRV': {
      const parts = tokens(raw);
      if (
        parts.length !== 4 ||
        !parts.slice(0, 3).every((part) => /^\d{1,5}$/.test(part)) ||
        !isName(parts[3] ?? '')
      ) {
        return { key: 'dns.srv', vars: { example: DNS_RECORD_TYPE_FORMATS.SRV } };
      }
      return null;
    }
    case 'CAA': {
      const parts = tokens(raw);
      if (parts.length < 3 || !/^\d{1,3}$/.test(parts[0] ?? '') || !/^[a-z0-9]+$/i.test(parts[1] ?? '')) {
        return { key: 'dns.caa', vars: { example: DNS_RECORD_TYPE_FORMATS.CAA } };
      }
      return null;
    }
    default:
      return null;
  }
}

// ─── comparaison ──────────────────────────────────────────────────────────────

/**
 * Deux régimes, un seul mécanisme.
 *
 *   `exact`    l'ensemble observé doit être exactement l'ensemble attendu. Un
 *              enregistrement **ajouté** est une anomalie — c'est la signature
 *              d'un détournement, et c'est pour ça que c'est le régime par
 *              défaut.
 *   `contains` les valeurs attendues doivent être présentes, le reste est
 *              toléré. Indispensable pour TXT, où un domaine porte de front un
 *              SPF, un DKIM et trois preuves de propriété dont on ne veut pas
 *              tenir l'inventaire.
 */
export const DNS_MATCH_MODES = ['exact', 'contains'] as const;
export const dnsMatchModeSchema = z.enum(DNS_MATCH_MODES);
export type DnsMatchMode = z.infer<typeof dnsMatchModeSchema>;

export type DnsComparison = {
  ok: boolean;
  /** Attendues et trouvées. */
  matched: string[];
  /** Attendues et absentes — une suppression ou une modification. */
  missing: string[];
  /** Observées et non attendues — un ajout. Vide si `contains`. */
  unexpected: string[];
};

export function compareDnsRecords(input: {
  type: DnsRecordType;
  expected: readonly string[];
  actual: readonly string[];
  match: DnsMatchMode;
}): DnsComparison {
  const actualByKey = new Map<string, string>();
  for (const value of input.actual) actualByKey.set(dnsComparisonKey(input.type, value), value);

  const expectedKeys = new Set(
    input.expected.map((value) => dnsComparisonKey(input.type, value)),
  );

  const matched: string[] = [];
  const missing: string[] = [];
  for (const value of input.expected) {
    const key = dnsComparisonKey(input.type, value);
    if (actualByKey.has(key)) matched.push(value);
    else missing.push(value);
  }

  const unexpected =
    input.match === 'contains'
      ? []
      : [...actualByKey.entries()]
          .filter(([key]) => !expectedKeys.has(key))
          .map(([, value]) => value);

  return { ok: missing.length === 0 && unexpected.length === 0, matched, missing, unexpected };
}

/**
 * Le constat, en une phrase — c'est ce qui part dans l'alerte.
 *
 * `maxChars` borne chaque liste : un domaine qui porte dix-sept TXT produirait
 * un message de plusieurs kilooctets, que ni Slack ni personne ne lit.
 */
export function describeDnsComparison(
  comparison: DnsComparison,
  maxChars = 400,
  language: UiLanguage = 'fr',
): string {
  const say = probeSay(language);
  const list = (values: readonly string[]): string => {
    const joined = values.join(', ');
    if (joined.length <= maxChars) return joined;
    return say('dns.total', { values: joined.slice(0, maxChars), count: values.length });
  };

  const parts: string[] = [];
  if (comparison.missing.length > 0) {
    parts.push(
      say('dns.missing', { count: comparison.missing.length, values: list(comparison.missing) }),
    );
  }
  if (comparison.unexpected.length > 0) {
    parts.push(say('dns.unexpected', { values: list(comparison.unexpected) }));
  }
  return parts.join(' · ');
}
