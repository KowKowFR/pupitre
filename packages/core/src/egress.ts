import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { renderMessage, type UiLanguage } from './i18n.js';
import { classifyAddress, type AddressCategory } from './monitors/ssrf.js';

/**
 * Une adresse saisie dans le panel, que le worker va appeler : l'API d'un
 * Nginx Proxy Manager, un webhook de notification, un stockage S3.
 *
 * La supervision exige une adresse publique (`monitors/ssrf.ts`) ; ici, on ne
 * le peut pas : ces destinations vivent souvent sur un réseau privé — un NPM
 * sur le LAN, un MinIO, un Mattermost interne —, et c'est légitime. Mais aucune
 * n'a de raison de viser une adresse **lien-local** : c'est là que les clouds
 * servent les métadonnées de la machine (`169.254.169.254`), identifiants
 * compris. Ni l'adresse « non spécifiée », ni une adresse de multidiffusion.
 *
 * Le nom est résolu et **toutes** ses adresses jugées : `metadata.google.internal`
 * ne se reconnaît qu'ainsi. Un DNS muet laisse passer — l'appel échouera de
 * lui-même, avec son vrai message.
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

/** Le refus, en donnée : `describe()` le dit dans la langue de qui le lira. */
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

/** Refuse une URL qui mène à une adresse lien-local, non spécifiée ou de multidiffusion. */
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
