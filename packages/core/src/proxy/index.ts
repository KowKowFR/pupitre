import { BunkerWebProvider } from './bunkerweb/provider.js';
import type { ProxyKind } from './model.js';
import { NginxProxyManagerProvider } from './npm/provider.js';
import { TraefikProvider } from './traefik/provider.js';
import { ProxyError, type ProxyProvider, type RemoteProxyProvider } from './types.js';

/**
 * The reverse proxies the panel can drive. One entry per kind: adding one means
 * writing its class and declaring it here — nothing else changes. Those running
 * on a machine driven over SSH on one side, those reached through their API on
 * the other: two contracts, because the latter have neither a machine to inspect
 * nor anything to install on it.
 */
const onTargets: Partial<Record<ProxyKind, () => ProxyProvider>> = {
  traefik: () => new TraefikProvider(),
  bunkerweb: () => new BunkerWebProvider(),
};

const remote: Partial<Record<ProxyKind, () => RemoteProxyProvider>> = {
  npm: () => new NginxProxyManagerProvider(),
};

export function getProxyProvider(kind: ProxyKind): ProxyProvider {
  const make = onTargets[kind];
  if (!make) {
    throw new ProxyError(`le proxy « ${kind} » ne tourne pas sur une cible`, kind, 'registry');
  }
  return make();
}

export function getRemoteProxyProvider(kind: ProxyKind): RemoteProxyProvider {
  const make = remote[kind];
  if (!make) throw new ProxyError(`le proxy « ${kind} » n'est pas distant`, kind, 'registry');
  return make();
}

/** The kinds that can be found or installed on a machine. */
export function implementedProxyKinds(): ProxyKind[] {
  return Object.keys(onTargets) as ProxyKind[];
}

export * from './catalog.js';
export * from './certificate-expiry.js';
export * from './direct-probe.js';
export * from './model.js';
export * from './bunkerweb/config.js';
export * from './bunkerweb/render.js';
export { BunkerWebProvider } from './bunkerweb/provider.js';
export * from './npm/config.js';
export {
  NpmClient,
  npmHealth,
  type NpmCertificate,
  type NpmHost,
  type NpmMark,
} from './npm/api.js';
export {
  NginxProxyManagerProvider,
  certificateCovers,
  coveringCertificate,
  npmDate,
  plainOnPublicAddress,
} from './npm/provider.js';
export * from './traefik/config.js';
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
