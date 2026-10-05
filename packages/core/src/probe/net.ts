import { lookup as dnsLookup } from 'node:dns/promises';
import {
  checkAddress,
  checkHostname,
  ssrfRefusalText,
  type Cidr,
  type SsrfRefusal,
} from '../monitors/ssrf.js';
import type { UiLanguage } from '../i18n.js';
import { probeSay } from './messages.js';

/**
 * The guarded resolution, shared by every probe.
 *
 * It is the only path by which a name becomes an address in this project. Every
 * probe implementation goes through here: the SSRF policy therefore cannot be
 * forgotten by a type that comes later.
 */

/**
 * The error carries the refusal **as data**, not only as a sentence.
 *
 * `reason` stays what it was — the French sentence, the one probes copy into a
 * reading's `detail` and Pino logs. `refusal` is the same thing, not rendered:
 * the panel uses it to say the same thing in the instance's language, without
 * having to translate an already written sentence again.
 */
export class SsrfBlockedError extends Error {
  override readonly name = 'SsrfBlockedError';
  readonly reason: string;
  constructor(
    readonly refusal: SsrfRefusal,
    readonly target: string,
  ) {
    super(ssrfRefusalText(refusal));
    this.reason = this.message;
  }
}

export type ResolvedTarget = {
  hostname: string;
  /** Literal address chosen for the connection. */
  address: string;
  family: 4 | 6;
  /** All the addresses returned by the resolver, all checked. */
  addresses: string[];
};

/**
 * Resolves a name and checks **all** the returned addresses, not only the one
 * that will be kept: a name pointing both at a public address and at
 * `127.0.0.1` is an attack, not redundancy.
 */
export async function resolveGuarded(
  hostname: string,
  allowlist: readonly Cidr[],
): Promise<ResolvedTarget> {
  const host = hostname.replace(/^\[|\]$/g, '');
  const shape = checkHostname(host);
  if (!shape.allowed) {
    throw new SsrfBlockedError(shape.refusal ?? { key: 'reason.hostRefused' }, host);
  }

  let records: Array<{ address: string; family: number }>;
  try {
    // `verbatim` keeps the resolver's order — we reorder nothing, we check
    // everything.
    records = await dnsLookup(host, { all: true, verbatim: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SsrfBlockedError({ key: 'reason.unresolved', vars: { host, message } }, host);
  }

  const noAddress: SsrfRefusal = { key: 'reason.noAddress', vars: { host } };
  if (records.length === 0) throw new SsrfBlockedError(noAddress, host);

  for (const record of records) {
    const verdict = checkAddress(record.address, allowlist);
    if (!verdict.allowed) throw new SsrfBlockedError(verdict.refusal, host);
  }

  const first = records[0];
  if (!first) throw new SsrfBlockedError(noAddress, host);

  return {
    hostname: host,
    address: first.address,
    family: first.family === 6 ? 6 : 4,
    addresses: records.map((record) => record.address),
  };
}

/** Resolves a URL's host, after checking its shape. */
export async function resolveUrlGuarded(
  url: string,
  allowlist: readonly Cidr[],
): Promise<{ target: ResolvedTarget; parsed: URL }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfBlockedError({ key: 'reason.unreadableUrl', vars: { value: url } }, url);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SsrfBlockedError(
      { key: 'reason.badScheme', vars: { scheme: parsed.protocol.replace(':', '') } },
      url,
    );
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new SsrfBlockedError({ key: 'reason.credentials' }, url);
  }
  return { target: await resolveGuarded(parsed.hostname, allowlist), parsed };
}

/**
 * A timeout, as data: `messageOf()` says it in the language of whoever will read
 * the reading, like an `SsrfBlockedError`'s refusal.
 */
export class ProbeTimeoutError extends Error {
  override readonly name = 'ProbeTimeoutError';
  constructor(readonly ms: number) {
    super(probeSay('fr')('timeout', { ms }));
  }
}

export function messageOf(error: unknown, language: UiLanguage = 'fr'): string {
  if (error instanceof ProbeTimeoutError) return probeSay(language)('timeout', { ms: error.ms });
  if (error instanceof SsrfBlockedError) return ssrfRefusalText(error.refusal, language);
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code ? `${code} — ${error.message}` : error.message;
  }
  return String(error);
}
