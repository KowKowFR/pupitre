import { z } from 'zod';
import type { UiLanguage } from '../i18n.js';
import { probeSay } from '../probe/messages.js';
import { parseIp } from './ssrf.js';
import { invalid, type ValidationRef } from '../validation.js';

/**
 * The DNS vocabulary, and **the comparison of two DNS answers**.
 *
 * A separate file, and **pure**: neither `node:dns` nor sockets. The DNS probe
 * (`@pupitre/core/probe`) queries; this module says what was expected and what
 * was obtained. Separating it allows testing the hard part — the comparison —
 * without network, and lets the catalog (imported by client components)
 * validate a configuration without pulling a native module.
 *
 * ── The trap, and it is the whole subject ───────────────────────────────────
 * A naive string comparator would produce an alert per query:
 *
 *   - **Order is not signal.** A resolver deliberately permutes the answers of
 *     one RRset (round-robin); two MX returned in another order are the same
 *     DNS. We therefore compare **sets**, never lists.
 *   - **A *name*'s case is not signal.** RFC 4343: domain names compare
 *     case-insensitively, and some resolvers deliberately return mixed case
 *     (0x20 encoding, an anti-poisoning defense). `Mail.Example.COM.` and
 *     `mail.example.com` are the same name.
 *   - **A *data*'s case is signal.** And it is the nuance a "lowercase
 *     everything" misses: a TXT's value is an arbitrary string. A DKIM key is
 *     base64, where `aB` and `Ab` are two different keys. Folding a TXT's case
 *     would not create a false alert — it would create a **false equality**,
 *     which is much worse for a probe meant to detect a hijack. Hence: case
 *     folded on names, never on data.
 *   - **The trailing dot is not signal.** `example.com.` and `example.com` are
 *     the same name; tools write them differently.
 *   - **How an address is written is not signal.** `2001:0db8:0000::1` and
 *     `2001:db8::1` are the same address. We therefore compare the **bytes**,
 *     not the text.
 *
 * Hence the shape chosen: each value — expected or observed — is reduced to a
 * canonical **comparison key**, and we compare sets of keys. The original value
 * is kept for display, because an alert message that shows a hexadecimal key
 * helps nobody.
 *
 * ── What the priority prefix does here ──────────────────────────────────────
 * An MX is a priority **and** a host: `10 mail1` then `20 mail2` is not the same
 * configuration as the reverse — it is the backup server that becomes the
 * primary. The priority therefore goes into the key. The same for SRV, where
 * weight and port decide where the traffic really goes.
 */

// ─── which record types, and why not the others ───────────────────────────────

/**
 * The types chosen.
 *
 * The criterion is not "what exists" but "whose failure is seen from outside and
 * gets repaired":
 *
 *   A / AAAA   where the name points. The most frequent and most total outage.
 *   CNAME      the alias — a CDN or a SaaS that was let go shows here.
 *   MX         mail. An MX error does not show on the site: nothing visibly
 *              breaks, mail simply disappears.
 *   NS         delegation. It is **the** target of a domain hijack: whoever
 *              changes the NS changes everything else without it showing.
 *   TXT        SPF, DKIM, DMARC, and ownership proofs. Deleting a verification
 *              TXT breaks an integration weeks later.
 *   CAA        who may issue a certificate for this domain. A CAA that
 *              disappears opens the door to an illegitimate issuance.
 *   SRV        services discovered through DNS (XMPP, SIP, LDAP, autodiscover).
 *              Little used, but when it is, it is critical and invisible
 *              otherwise.
 *
 * **SOA is left out**, although every commercial service offers it. An SOA
 * carries a serial number that **changes at each zone modification**: a probe
 * comparing an SOA would alert at each legitimate edit, that is exactly when the
 * administrator already knows what they are doing. And what an SOA teaches that
 * is useful — does the zone still exist, who is its primary — is already
 * carried by NS, which does not move. A probe that cries at each normal change
 * ends up ignored, and that is the worst state for monitoring.
 *
 * **PTR is left out** too: it is queried on an `in-addr.arpa` name, not on a
 * domain, and it is configured at the address's host, not at the name's holder.
 * It is not the same object, nor the same person to warn.
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

// What each type observes is written in the catalog, under the `dns.record.*`
// keys of `monitorCatalogCopy`: that is where the screen looks for it, in the
// instance's language. The table that lived here no longer had a reader.

/** The shape an expected value must take. Shown as an input hint. */
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

/** The types whose data is a domain name — case and trailing dot irrelevant. */
const NAME_VALUED: ReadonlySet<DnsRecordType> = new Set<DnsRecordType>(['CNAME', 'NS']);

// ─── canonicalisation ─────────────────────────────────────────────────────────

/** A domain name, reduced to what distinguishes it: lowercase, no trailing dot. */
export function normalizeDnsName(value: string): string {
  return value.trim().replace(/\.+$/, '').toLowerCase();
}

/**
 * An address, reduced to its bytes. That is what makes `2001:0db8:0000::1` and
 * `2001:db8::1` equal without having to reimplement IPv6 compression.
 */
function addressKey(value: string): string | null {
  const parsed = parseIp(value.trim());
  if (!parsed) return null;
  return `${parsed.family}:${parsed.bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * `dig` returns a long TXT string in quoted chunks: `"v=spf1 ..." "... ~all"`. A
 * human pastes what they see; we therefore glue the chunks back, as a resolver
 * does. Without quotes, the value is taken as is.
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
 * The **comparison key** of a value, expected or observed.
 *
 * Two values are "the same record" if and only if their keys are identical.
 * The whole rest of the module only manipulates sets of keys.
 */
export function dnsComparisonKey(type: DnsRecordType, value: string): string {
  const raw = value.trim();

  if (type === 'A' || type === 'AAAA') {
    // An unreadable value keeps a stable key: it will match nothing, which is the
    // wanted behavior, and the message will show the entered text.
    return addressKey(raw) ?? `?${raw.toLowerCase()}`;
  }

  if (NAME_VALUED.has(type)) return normalizeDnsName(raw);

  if (type === 'TXT') {
    // No case folding: a TXT's data is arbitrary, and a base64 DKIM key
    // distinguishes `aB` from `Ab`.
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

  // CAA: `<flags> <tag> <value>`. The tag is case-insensitive (RFC 8659); the
  // value is an authority name or a contact URL, which we fold too — two CAs are
  // not told apart by an uppercase letter.
  const parts = tokens(raw);
  if (parts.length < 3) return `?${raw.toLowerCase()}`;
  const [flags, tag, ...rest] = parts;
  const payload = joinTxtChunks(rest.join(' ')).trim().toLowerCase();
  return `${Number(flags)} ${(tag ?? '').toLowerCase()} ${payload}`;
}

// ─── entering an expected list ────────────────────────────────────────────────

/**
 * Splits the entered text into expected values.
 *
 * A line break always separates. A comma only separates for the types whose
 * data cannot contain one: a comma is perfectly legal in a TXT
 * (`v=spf1 ip4:a,ip4:b` at some), and splitting on it would silently break the
 * expected value — the worst of bugs, the one that produces an alert nobody
 * understands.
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
    // Two spellings of the same value only count once, otherwise an "exactly these
    // values" would become unsatisfiable.
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/** Shape check of an expected value. `null` = the shape is fine. */
export function validateDnsRecordValue(type: DnsRecordType, value: string): string | null {
  const problem = dnsRecordProblem(type, value);
  return problem === null ? null : invalid(problem.key, problem.vars).message;
}

/** The same check, the complaint as data — for a schema. */
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
 * Two regimes, one mechanism.
 *
 *   `exact`    the observed set must be exactly the expected set. An **added**
 *              record is an anomaly — it is the signature of a hijack, and that
 *              is why it is the default regime.
 *   `contains` the expected values must be present, the rest is tolerated.
 *              Essential for TXT, where a domain carries at once an SPF, a DKIM
 *              and three ownership proofs we do not want to keep an inventory
 *              of.
 */
export const DNS_MATCH_MODES = ['exact', 'contains'] as const;
export const dnsMatchModeSchema = z.enum(DNS_MATCH_MODES);
export type DnsMatchMode = z.infer<typeof dnsMatchModeSchema>;

export type DnsComparison = {
  ok: boolean;
  /** Expected and found. */
  matched: string[];
  /** Expected and absent — a deletion or a modification. */
  missing: string[];
  /** Observed and not expected — an addition. Empty if `contains`. */
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
 * The finding, in one sentence — it is what goes into the alert.
 *
 * `maxChars` caps each list: a domain carrying seventeen TXT records would
 * produce a message of several kilobytes, which neither Slack nor anybody reads.
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
