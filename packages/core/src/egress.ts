import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { renderMessage, type UiLanguage } from './i18n.js';
import { classifyAddress, type AddressCategory } from './monitors/ssrf.js';

/**
 * An address entered in the panel, which the worker will call: a Nginx Proxy
 * Manager's API, a notification webhook, an S3 storage.
 *
 * Monitoring requires a public address (`monitors/ssrf.ts`); here we cannot:
 * these destinations often live on a private network — an NPM on the LAN, a
 * MinIO, an internal Mattermost —, and that is legitimate. But none has a reason
 * to target a **link-local** address: that is where clouds serve the machine's
 * metadata (`169.254.169.254`), credentials included. Nor the "unspecified"
 * address, nor a multicast address.
 *
 * The name is resolved and **all** its addresses judged:
 * `metadata.google.internal` can only be recognized that way. A silent DNS lets
 * it through — the call will fail by itself, with its real message.
 */

const FORBIDDEN: ReadonlySet<AddressCategory> = new Set<AddressCategory>([
  'link-local',
  'unspecified',
  'multicast',
]);

const egressCopy = {
  fr: {
    linkLocal:
      '{host} mène à {address}, une adresse lien-local — celle des services de métadonnées des clouds : refusé',
    unusable: "{host} mène à {address}, une adresse qu'aucun service ne peut porter : refusé",
  },
  en: {
    linkLocal:
      '{host} leads to {address}, a link-local address — that of the clouds’ metadata services: refused',
    unusable: '{host} leads to {address}, an address no service can hold: refused',
  },
} as const;

/** The refusal, as data: `describe()` says it in the language of whoever reads it. */
export class EgressRefusedError extends Error {
  constructor(
    readonly host: string,
    readonly address: string,
    readonly linkLocal: boolean,
  ) {
    super(renderMessage(egressCopy, 'fr', linkLocal ? 'linkLocal' : 'unusable', { host, address }));
    this.name = 'EgressRefusedError';
  }

  describe(language: UiLanguage): string {
    return renderMessage(egressCopy, language, this.linkLocal ? 'linkLocal' : 'unusable', {
      host: this.host,
      address: this.address,
    });
  }
}

type Resolve = (host: string) => Promise<string[]>;

const resolveAll: Resolve = async (host) =>
  (await lookup(host, { all: true })).map((entry) => entry.address);

/** Refuses a URL that leads to a link-local, unspecified or multicast address. */
export async function assertEgressAllowed(
  url: string,
  resolve: Resolve = resolveAll,
): Promise<void> {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : await resolve(host).catch(() => []);
  for (const address of addresses) {
    const category = classifyAddress(address);
    if (category && FORBIDDEN.has(category)) {
      throw new EgressRefusedError(host, address, category === 'link-local');
    }
  }
}
