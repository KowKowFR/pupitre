import type { ProxyKind } from './model.js';
import { TraefikProvider } from './traefik/provider.js';
import { ProxyError, type ProxyProvider } from './types.js';

/**
 * Les reverse proxies que le panel sait piloter. Une entrée par genre : en
 * ajouter un, c'est écrire sa classe et la déclarer ici — rien d'autre ne change.
 * `null` : le genre est connu de la base, son provider n'existe pas encore.
 */
const registry: Record<ProxyKind, (() => ProxyProvider) | null> = {
  traefik: () => new TraefikProvider(),
  bunkerweb: null,
};

export function getProxyProvider(kind: ProxyKind): ProxyProvider {
  const make = registry[kind];
  if (!make)
    throw new ProxyError(`le proxy « ${kind} » n'a pas encore d'implémentation`, kind, 'registry');
  return make();
}

export function implementedProxyKinds(): ProxyKind[] {
  return (Object.keys(registry) as ProxyKind[]).filter((kind) => registry[kind] !== null);
}

export * from './model.js';
export * from './probe.js';
export * from './reach.js';
export * from './types.js';
export {
  TraefikProvider,
  parseIngressClasses,
  parseTraefikDeployment,
} from './traefik/provider.js';
export * from './traefik/detect.js';
export * from './traefik/install.js';
export * from './traefik/render.js';
