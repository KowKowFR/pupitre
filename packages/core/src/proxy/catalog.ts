import { bunkerwebDescriptor } from './bunkerweb/config.js';
import type { AcmeSettings, ProxyCapabilities, ProxyDescriptor, ProxyKind } from './model.js';
import { traefikDescriptor } from './traefik/config.js';

/**
 * Les genres de proxy, tels qu'ils se décrivent — sans rien exécuter.
 * L'écran et l'API passent par ici pour lire une configuration, la décrire et
 * savoir ce qu'elle permet ; ce qui parle à une machine vit dans les providers
 * (`@pupitre/core/proxy`). Ajouter un proxy : une fiche ici, une classe là.
 */
const descriptors: Record<ProxyKind, ProxyDescriptor<never>> = {
  traefik: traefikDescriptor as ProxyDescriptor<never>,
  bunkerweb: bunkerwebDescriptor as ProxyDescriptor<never>,
};

function descriptorOf(kind: ProxyKind): ProxyDescriptor<unknown> {
  return descriptors[kind] as ProxyDescriptor<unknown>;
}

/** Le nom d'un genre de proxy, pour l'écran. */
export function proxyKindLabel(kind: ProxyKind): string {
  return descriptorOf(kind).label;
}

/** La configuration d'une connexion, validée selon son genre. */
export function parseProxyConfig(kind: ProxyKind, config: unknown): unknown {
  return descriptorOf(kind).parseConfig(config);
}

export function proxyCapabilities(kind: ProxyKind, config: unknown): ProxyCapabilities {
  const descriptor = descriptorOf(kind);
  return descriptor.capabilities(descriptor.parseConfig(config));
}

/** Une ligne pour l'écran : de quoi reconnaître la connexion. */
export function describeProxy(kind: ProxyKind, config: unknown): string {
  const descriptor = descriptorOf(kind);
  return descriptor.describe(descriptor.parseConfig(config));
}

/** L'autorité de certification réglée par Pupitre, pour la dire. */
export function proxyAcme(
  kind: ProxyKind,
  config: unknown,
): Pick<AcmeSettings, 'email' | 'server'> | null {
  const descriptor = descriptorOf(kind);
  return descriptor.acme(descriptor.parseConfig(config));
}
