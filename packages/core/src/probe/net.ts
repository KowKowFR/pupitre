import { lookup as dnsLookup } from 'node:dns/promises';
import {
  checkAddress,
  checkHostname,
  ssrfRefusalText,
  type Cidr,
  type SsrfRefusal,
} from '../monitors/ssrf.js';

/**
 * La résolution contrôlée, partagée par toutes les sondes.
 *
 * C'est le seul chemin par lequel un nom devient une adresse dans ce projet.
 * Toute implémentation de sonde passe par ici : la politique SSRF ne peut donc
 * pas être oubliée par un type qui arrive plus tard.
 */

/**
 * L'erreur porte le refus **en donnée**, pas seulement en phrase.
 *
 * `reason` reste ce qu'il était — la phrase française, celle que les sondes
 * recopient en `detail` d'un relevé et que Pino journalise. `refusal` est la
 * même chose non rendue : le panel s'en sert pour dire la même chose dans la
 * langue de l'instance, sans avoir à retraduire une phrase déjà écrite.
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
  /** Adresse littérale retenue pour la connexion. */
  address: string;
  family: 4 | 6;
  /** Toutes les adresses rendues par le résolveur, toutes contrôlées. */
  addresses: string[];
};

/**
 * Résout un nom et contrôle **toutes** les adresses rendues, pas seulement
 * celle qu'on retiendra : un nom qui pointe à la fois sur une adresse publique
 * et sur `127.0.0.1` est une attaque, pas une redondance.
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
    // `verbatim` conserve l'ordre du résolveur — on ne réordonne rien, on
    // contrôle tout.
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

/** Résout l'hôte d'une URL, après contrôle de sa forme. */
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

export function messageOf(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code ? `${code} — ${error.message}` : error.message;
  }
  return String(error);
}
