import { lookup as dnsLookup } from 'node:dns/promises';
import { checkAddress, checkHostname, type Cidr } from '../monitors/ssrf.js';

/**
 * La résolution contrôlée, partagée par toutes les sondes.
 *
 * C'est le seul chemin par lequel un nom devient une adresse dans ce projet.
 * Toute implémentation de sonde passe par ici : la politique SSRF ne peut donc
 * pas être oubliée par un type qui arrive plus tard.
 */

export class SsrfBlockedError extends Error {
  override readonly name = 'SsrfBlockedError';
  constructor(
    readonly reason: string,
    readonly target: string,
  ) {
    super(reason);
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
  if (!shape.allowed) throw new SsrfBlockedError(shape.reason ?? 'hôte refusé', host);

  let records: Array<{ address: string; family: number }>;
  try {
    // `verbatim` conserve l'ordre du résolveur — on ne réordonne rien, on
    // contrôle tout.
    records = await dnsLookup(host, { all: true, verbatim: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SsrfBlockedError(`nom « ${host} » non résolu : ${message}`, host);
  }

  if (records.length === 0) throw new SsrfBlockedError(`nom « ${host} » sans adresse`, host);

  for (const record of records) {
    const verdict = checkAddress(record.address, allowlist);
    if (!verdict.allowed) throw new SsrfBlockedError(verdict.reason, host);
  }

  const first = records[0];
  if (!first) throw new SsrfBlockedError(`nom « ${host} » sans adresse`, host);

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
    throw new SsrfBlockedError(`URL illisible « ${url} »`, url);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SsrfBlockedError(
      `schéma « ${parsed.protocol.replace(':', '')} » refusé — http ou https uniquement`,
      url,
    );
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new SsrfBlockedError("une URL de sonde ne porte pas d'identifiants", url);
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
