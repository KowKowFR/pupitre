import { bunkerwebDescriptor } from './bunkerweb/config.js';
import type {
  AcmeSettings,
  ProxyCapabilities,
  ProxyDescriptor,
  ProxyKind,
  ProxyPlacement,
} from './model.js';
import { PROXY_KINDS } from './model.js';
import { npmDescriptor } from './npm/config.js';
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
  npm: npmDescriptor as ProxyDescriptor<never>,
};

function descriptorOf(kind: ProxyKind): ProxyDescriptor<unknown> {
  return descriptors[kind] as ProxyDescriptor<unknown>;
}

/** Le nom d'un genre de proxy, pour l'écran. */
export function proxyKindLabel(kind: ProxyKind): string {
  return descriptorOf(kind).label;
}

/** Où tourne un genre de proxy : sur une machine pilotée en SSH, ou ailleurs, joint par son API. */
export function proxyPlacement(kind: ProxyKind): ProxyPlacement {
  return descriptorOf(kind).placement;
}

/** Les genres qu'on connecte par leur API, hors des cibles. */
export function remoteProxyKinds(): ProxyKind[] {
  return PROXY_KINDS.filter((kind) => descriptorOf(kind).placement === 'remote');
}

/**
 * Les secrets d'une connexion à un proxy distant, validés selon son genre.
 * Un genre qui n'en a pas les refuse : rien ne doit être rangé à leur place.
 */
export function parseProxySecrets(kind: ProxyKind, secrets: unknown): Record<string, string> {
  const descriptor = descriptorOf(kind);
  if (!descriptor.parseSecrets) throw new Error(`le proxy « ${kind} » n'a pas de secrets`);
  return descriptor.parseSecrets(secrets);
}

/** Où un proxy distant reçoit les visiteurs ; `null` pour un proxy sur une machine. */
export function proxyEntrypointHost(kind: ProxyKind, config: unknown): string | null {
  const descriptor = descriptorOf(kind);
  return descriptor.entrypointHost?.(descriptor.parseConfig(config)) ?? null;
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
