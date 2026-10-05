import { z } from 'zod';
import { renderMessage, type Translated, type UiLanguage, type Vars } from '../i18n.js';

/**
 * ⚠ Monitoring's SSRF policy.
 *
 * The risk, stated frankly: this feature makes a server fetch a target
 * **provided by a user**. It is an SSRF by construction. Someone who can create
 * a probe could make the worker send a request to `http://localhost:5432`, to
 * `10.0.0.0/8`, or to `169.254.169.254` — a cloud's metadata service, which
 * returns credentials.
 *
 * ── The decision ─────────────────────────────────────────────────────────────
 *
 * 1. **Scheme**: `http` and `https` only. No `file:`, `gopher:`, `ftp:`, nor
 *    URLs carrying credentials (`user:pass@`).
 *
 * 2. **Addresses**: everything is refused except public ones. A *total* block of
 *    private addresses would be absurd — this panel monitors precisely internal
 *    machines. Opening up is therefore done through a **CIDR allow list**,
 *    `MONITOR_ALLOWED_CIDRS`, read from the panel's and the worker's environment.
 *
 *    Why the environment, and not an instance setting or a permission? Because a
 *    permission would be a decoy: `monitor:manage` is precisely what whoever
 *    creates a probe carries; also giving it the right to lift the guard amounts
 *    to having no guard. "Which internal ranges may this panel reach" is a
 *    **deployment** decision, made by whoever holds the `.env` — in the same
 *    place as `MASTER_KEY` and `DRIVER_PORT_RANGE`. Nobody widens it from the
 *    interface.
 *
 * 3. **Never allowable**, whatever the list: link-local (`169.254.0.0/16`,
 *    `fe80::/10`) which carries the metadata services, multicast, reserved, and
 *    the unspecified address. A metadata service is not a site to monitor, it is
 *    a token dispenser.
 *
 * 4. **Redirects**: checking the starting address is not enough — a public URL
 *    can return a 302 to `http://169.254.169.254`. Each hop is therefore
 *    resolved and checked again, and there are five at most.
 *
 * 5. **DNS rebinding**: the probe resolves the name once, checks *all* the
 *    returned addresses, then connects to the chosen address **as a literal**,
 *    with the original name's `Host` header and SNI. There is therefore no
 *    second resolution between the check and the connection: the TOCTOU window
 *    is closed.
 *
 * 6. **Response size** capped, timeout capped.
 *
 * 7. **Requests to a third party the operator did not choose do not inherit the
 *    allow list.** The domain expiry probe does not reach the target: it reaches
 *    a registry's RDAP server, designated by IANA's bootstrap list. Nobody in
 *    this panel decided on that address.
 *
 *    But `MONITOR_ALLOWED_CIDRS` answers a precise question — "which internal
 *    ranges may this panel reach *to monitor the operator's fleet*" — and not
 *    "which ranges may a third party make us reach". Letting the RDAP request
 *    inherit that opening would amount to accepting that a wrong bootstrap
 *    entry, or a poisoned DNS, brings an outgoing request into the operator's
 *    10.0.0.0/8 — and they would have allowed it without ever wanting to.
 *
 *    These calls therefore go through `PUBLIC_ONLY` (`probe/fetch.ts`): public
 *    addresses only, whatever the configuration. A registry is on the public
 *    Internet by definition; if it resolves to a private address, it is an
 *    anomaly to refuse, not an exception to accommodate. The rule also holds for
 *    the bootstrap list itself, whose URL is hard-coded and never derived from
 *    an input, and comes with an `https` requirement: an RDAP response altered
 *    in transit would say anything about an expiry date.
 *
 * This policy holds for **all** probe types, present and future — HTTP,
 * keyword, TLS, TCP, DNS, RDAP. It lives here, apart from the catalog, so that
 * no implementation has to rewrite it or gets the chance to forget it; and the
 * request loop that applies it exists in a single copy, in `probe/fetch.ts`, for
 * the same reason — a second copy always diverges.
 *
 * ── What the guard protects exactly: the socket, not the target ─────────────
 *
 * Two recent types force stating the rule more precisely than "we check the
 * target".
 *
 * **TCP** is the dangerous case, and it must be said frankly: a probe that takes
 * a host and a port *is* the primitive of an internal network scanner. It
 * returns, in clear, "this port accepts / refuses / does not answer", that is
 * exactly what `nmap` returns. It is more dangerous than the HTTP probe, which
 * at least speaks a protocol and stumbles on services that do not speak it. It
 * therefore goes through **the same** `resolveGuarded()`, without exception and
 * without a bypass: nothing in `tcp.ts` opens a socket to anything other than
 * the literal address the guard validated.
 *
 * **DNS** is the subtle case: the probe does **not** connect to what it
 * monitors. It asks a question *about* a name, to a resolver. The addresses it
 * gets in response are **data** — compared, never reached. Checking them would
 * make no sense: monitoring "the A of db.internal is indeed 10.0.0.5" is
 * legitimate and reaches nothing.
 *
 * Hence the wording chosen, which covers the four types without a special case:
 *
 *     the guard applies to **every endpoint the worker opens a socket to**, and
 *     to nothing else.
 *
 * For DNS, that endpoint is the **resolver** — and it is indeed what is checked.
 * With one explicit exception: the *system's* resolver, the one in
 * `/etc/resolv.conf`, is not a user input but a deployment fact — in a container
 * it is often `127.0.0.11`, which the guard would wrongly refuse. A resolver
 * **declared in the probe**, on the other hand, is a user input: it is checked
 * like any target.
 *
 * A residual risk remains, accepted and named: querying `<data>.attacker.com`
 * makes the resolver send a request to a server chosen by whoever created the
 * probe — a slow exfiltration channel. It brings nothing to someone who already
 * carries `monitor:manage`, who can make an HTTP request go to any public host;
 * and refusing it would require an allow list of names, which does not exist.
 *
 * ── What stays open, and is accepted ────────────────────────────────────────
 * An allowed range is allowed for every probe: there is no per-user
 * granularity. And a probe allowed on an internal range can serve as a slow
 * port scanner (the response code and the latency leak). It is the price of
 * monitoring an internal fleet; the allow list is there so that this price is
 * paid knowingly, on named ranges.
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

/** Categories no allow list can unlock. */
const NEVER_ALLOWED: ReadonlySet<AddressCategory> = new Set<AddressCategory>([
  'link-local',
  'multicast',
  'reserved',
  'unspecified',
]);

/**
 * A refusal's words — and only the words.
 *
 * ── Why **data** and not a sentence ─────────────────────────────────────────
 * An SSRF refusal does not stop here: it goes through `SsrfBlockedError`, comes
 * up as a 422 in the probe form's banner, and is copied into a reading's
 * `detail`. The first is shown in the instance's language, the second is a
 * trace of a past event that stays as is. A function cannot render both if it
 * only returns a string.
 *
 * Each refusal is therefore an `SsrfRefusal` — a key and its variables — that
 * the caller renders in the language that suits *its* use. The verdicts also
 * carry a `reason` already rendered in French: it is the project's source
 * language, the one of logs and readings, and it leaves intact the callers that
 * have no language to offer.
 *
 * French hangs the category after "une adresse", English carries it whole in
 * the substitution. The two templates therefore do not have the same shape, and
 * that is exactly what a translation is supposed to do.
 */
const fr = {
  'category.public': 'publique',
  'category.loopback': 'de bouclage',
  'category.private': 'privée',
  'category.unique-local': 'locale unique (IPv6)',
  'category.cgnat': 'de NAT opérateur',
  'category.link-local': 'de lien local — ce sont les services de métadonnées',
  'category.multicast': 'de multidiffusion',
  'category.reserved': 'réservée',
  'category.unspecified': 'indéterminée',

  'reason.unreadableAddress': 'adresse illisible « {value} »',
  'reason.neverAllowed':
    '{value} est une adresse {category} — ' +
    "elle ne peut être autorisée par aucune liste, c'est une règle du panel",
  'reason.notListed':
    "{value} est une adresse {category} et n'appartient à aucune plage " +
    'autorisée — ajouter la plage à MONITOR_ALLOWED_CIDRS pour la superviser',
  'reason.noHostname': "la cible n'a pas de nom d'hôte",
  'reason.localhost': '« localhost » ne se supervise pas depuis le worker',
  'reason.unreadableUrl': 'URL illisible « {value} »',
  'reason.badScheme': 'schéma « {scheme} » refusé — http ou https uniquement',
  'reason.credentials': "une URL de sonde ne porte pas d'identifiants",
  'reason.unresolved': 'nom « {host} » non résolu : {message}',
  'reason.noAddress': 'nom « {host} » sans adresse',
  'reason.hostRefused': 'hôte refusé',
} as const;

const en: Translated<typeof fr> = {
  'category.public': 'a public address',
  'category.loopback': 'a loopback address',
  'category.private': 'a private address',
  'category.unique-local': 'a unique-local address (IPv6)',
  'category.cgnat': 'a carrier-grade NAT address',
  'category.link-local': 'a link-local address — that is where metadata services live',
  'category.multicast': 'a multicast address',
  'category.reserved': 'a reserved address',
  'category.unspecified': 'an unspecified address',

  'reason.unreadableAddress': 'unreadable address “{value}”',
  'reason.neverAllowed': '{value} is {category} — no allowlist opens it, that is a panel rule',
  'reason.notListed':
    '{value} is {category} and sits in no allowed range — ' +
    'add the range to MONITOR_ALLOWED_CIDRS to monitor it',
  'reason.noHostname': 'the target has no hostname',
  'reason.localhost': '“localhost” is not monitored from the worker',
  'reason.unreadableUrl': 'unreadable URL “{value}”',
  'reason.badScheme': 'scheme “{scheme}” refused — http or https only',
  'reason.credentials': 'a probe URL carries no credentials',
  'reason.unresolved': 'name “{host}” did not resolve: {message}',
  'reason.noAddress': 'name “{host}” has no address',
  'reason.hostRefused': 'host refused',
};

export const ssrfCopy = { fr, en };

export type SsrfReasonKey = keyof typeof fr;

/**
 * A refusal, designated rather than written. The sentence is made at the time
 * it is shown, in the language that suits that display.
 *
 * `category` is apart from `vars` because it is the only substitution that is
 * itself a sentence to translate: keeping it as data until rendering is what
 * prevents a refusal from freezing a language at the time it is raised.
 */
export type SsrfRefusal = {
  readonly key: SsrfReasonKey;
  readonly vars?: Vars;
  readonly category?: AddressCategory;
};

/** Renders a refusal. French by default: it is the language of logs and readings. */
export function ssrfRefusalText(refusal: SsrfRefusal, language: UiLanguage = 'fr'): string {
  const category =
    refusal.category === undefined
      ? undefined
      : renderMessage(ssrfCopy, language, `category.${refusal.category}` as SsrfReasonKey);
  const vars = category === undefined ? refusal.vars : { ...refusal.vars, category };
  return renderMessage(ssrfCopy, language, refusal.key, vars);
}

/** An address, normalized to bytes. 4 for IPv4, 16 for IPv6. */
export type IpAddress = { bytes: number[]; family: 4 | 6 };

export function parseIpv4(value: string): IpAddress | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    // `01` and `1e2` are not octets: only the canonical decimal form is accepted,
    // otherwise `0177.0.0.1` (octal) would bypass the check.
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith('0')) return null;
    const byte = Number(part);
    if (byte > 255) return null;
    bytes.push(byte);
  }
  return { bytes, family: 4 };
}

export function parseIpv6(value: string): IpAddress | null {
  // The zone suffix (`fe80::1%eth0`) does not change the address.
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
        // Mixed form `::ffff:127.0.0.1` — only in last position.
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
 * An IPv6 address that wraps IPv4 must be judged on the IPv4 it carries —
 * otherwise `::ffff:127.0.0.1` would pass for any IPv6.
 */
function unwrapIpv4(address: IpAddress): IpAddress {
  if (address.family !== 6) return address;
  const { bytes } = address;
  const v4 = { bytes: bytes.slice(12), family: 4 as const };
  // `::ffff:a.b.c.d` — the mapped form, by far the most common.
  if (inRange(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], 96)) return v4;
  // `64:ff9b::/96` — NAT64 translation.
  if (inRange(bytes, [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0], 96)) return v4;
  // `::a.b.c.d` — IPv4-compatible, obsolete but still accepted by stacks.
  // `bytes[12] !== 0` rules out `::1`, which is real IPv6 loopback.
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

// ─── allow list ───────────────────────────────────────────────────────────────

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

/** `MONITOR_ALLOWED_CIDRS`: comma-separated CIDRs. Empty = nothing open. */
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
  // A CIDR written in IPv6 but wrapping IPv4 keeps its prefix bits expressed over
  // 128: we bring them back to the IPv4 scale.
  const bits =
    cidr.address.family === 6 && base.family === 4 ? Math.max(0, cidr.bits - 96) : cidr.bits;
  return inRange(target.bytes, base.bytes, bits);
}

/**
 * A refusal verdict carries both: the refusal as data (`refusal`) for whoever
 * must show it, and the French sentence already rendered (`reason`) for whoever
 * writes it into a reading or a log. No existing caller moved.
 */
export type AddressVerdict =
  | { allowed: true; category: AddressCategory; via: string | null }
  | { allowed: false; category: AddressCategory | null; refusal: SsrfRefusal; reason: string };

function refused(refusal: SsrfRefusal, category: AddressCategory | null = null) {
  return { allowed: false as const, category, refusal, reason: ssrfRefusalText(refusal) };
}

/**
 * The verdict of the checks that judge a **shape** — a host name, a URL, a
 * literal address — without an allow list or network.
 */
export type ShapeVerdict = { allowed: boolean; refusal?: SsrfRefusal; reason?: string };

function refusedShape(refusal: SsrfRefusal): ShapeVerdict {
  return { allowed: false, refusal, reason: ssrfRefusalText(refusal) };
}

/** The check of an address, once resolved. Single entry point. */
export function checkAddress(value: string, allowlist: readonly Cidr[]): AddressVerdict {
  const parsed = parseIp(value);
  const category = parsed ? classifyAddress(value) : null;
  if (!parsed || category === null) {
    return refused({ key: 'reason.unreadableAddress', vars: { value } });
  }
  if (category === 'public') return { allowed: true, category, via: null };

  if (NEVER_ALLOWED.has(category)) {
    return refused({ key: 'reason.neverAllowed', vars: { value }, category }, category);
  }

  const match = allowlist.find((cidr) => cidrContains(cidr, parsed));
  if (match) return { allowed: true, category, via: match.text };

  return refused({ key: 'reason.notListed', vars: { value }, category }, category);
}

/**
 * What no list will ever unlock, judged **without resolution or environment**.
 *
 * Useful because the most important refusal — the metadata service — must be
 * able to fall as early as possible: in the Zod schema, when the probe is
 * created, where one can neither read `MONITOR_ALLOWED_CIDRS` (the catalog is
 * imported by client components) nor make a DNS request (a validation does no
 * network). A literal address needs neither: it is judged on its face.
 *
 * Returns `{ allowed: true }` for a name: a name is only judged once resolved,
 * and it is `resolveGuarded()` that handles it.
 */
export function checkNeverAllowable(value: string): ShapeVerdict {
  const category = classifyAddress(value);
  if (category === null) return { allowed: true };
  if (!NEVER_ALLOWED.has(category)) return { allowed: true };
  return refusedShape({ key: 'reason.neverAllowed', vars: { value }, category });
}

/** Check of a host name, before any resolution. */
export function checkHostname(hostname: string): ShapeVerdict {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (host === '') return refusedShape({ key: 'reason.noHostname' });
  // `localhost` does not always resolve to 127.0.0.1; we refuse it by its name on
  // top of its address, so that the message is clear.
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return refusedShape({ key: 'reason.localhost' });
  }
  // A target written as a literal address is judged right away, without waiting
  // for resolution: `169.254.169.254` has no reason to be accepted at creation
  // only to be refused at the first sweep, an hour later. Only the categories no
  // list unlocks fall here; loopback and private depend on
  // `MONITOR_ALLOWED_CIDRS`, which is not readable from here.
  return checkNeverAllowable(host);
}

/** Scheme, credentials, host name. DNS resolution comes later, in the probe. */
export function checkUrlShape(value: string): ShapeVerdict {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return refusedShape({ key: 'reason.unreadableUrl', vars: { value } });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return refusedShape({
      key: 'reason.badScheme',
      vars: { scheme: url.protocol.replace(':', '') },
    });
  }
  if (url.username !== '' || url.password !== '') {
    return refusedShape({ key: 'reason.credentials' });
  }
  return checkHostname(url.hostname);
}

/**
 * A refusal's complaint: its French sentence, and the refusal as data — the
 * screen says it again in its language (`issueMessage()` in `validation.ts`).
 */
function refusalIssue(verdict: ShapeVerdict, fallback: string) {
  return {
    code: 'custom' as const,
    message: verdict.reason ?? fallback,
    ...(verdict.refusal ? { params: { ssrf: verdict.refusal } } : {}),
  };
}

/** Probe URL: the shape is validated here, the addresses at probe time. */
export const monitorUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .superRefine((value, ctx) => {
    const verdict = checkUrlShape(value);
    if (!verdict.allowed) ctx.addIssue(refusalIssue(verdict, 'URL refusée'));
  });

/** Probe host name — for the types that do not speak HTTP (TLS, tomorrow DNS). */
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
      ctx.addIssue(refusalIssue(verdict, 'hôte refusé'));
    }
  });
