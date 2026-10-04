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
 * The kinds of proxy, as they describe themselves — without running anything.
 * The screen and the API go through here to read a configuration, describe it
 * and know what it allows; what talks to a machine lives in the providers
 * (`@pupitre/core/proxy`). Adding a proxy: one entry here, one class there.
 */
const descriptors: Record<ProxyKind, ProxyDescriptor<never>> = {
  traefik: traefikDescriptor as ProxyDescriptor<never>,
  bunkerweb: bunkerwebDescriptor as ProxyDescriptor<never>,
  npm: npmDescriptor as ProxyDescriptor<never>,
};

function descriptorOf(kind: ProxyKind): ProxyDescriptor<unknown> {
  return descriptors[kind] as ProxyDescriptor<unknown>;
}

/** The name of a kind of proxy, for the screen. */
export function proxyKindLabel(kind: ProxyKind): string {
  return descriptorOf(kind).label;
}

/** Where a kind of proxy runs: on a machine driven over SSH, or elsewhere, reached by its API. */
export function proxyPlacement(kind: ProxyKind): ProxyPlacement {
  return descriptorOf(kind).placement;
}

/** The kinds connected through their API, outside the targets. */
export function remoteProxyKinds(): ProxyKind[] {
  return PROXY_KINDS.filter((kind) => descriptorOf(kind).placement === 'remote');
}

/**
 * The secrets of a connection to a remote proxy, validated according to its
 * kind. A kind that has none refuses them: nothing must be stored in their place.
 */
export function parseProxySecrets(kind: ProxyKind, secrets: unknown): Record<string, string> {
  const descriptor = descriptorOf(kind);
  if (!descriptor.parseSecrets) throw new Error(`the "${kind}" proxy has no secrets`);
  return descriptor.parseSecrets(secrets);
}

/** Where a remote proxy receives visitors; `null` for a proxy on a machine. */
export function proxyEntrypointHost(kind: ProxyKind, config: unknown): string | null {
  const descriptor = descriptorOf(kind);
  return descriptor.entrypointHost?.(descriptor.parseConfig(config)) ?? null;
}

/** A connection's configuration, validated according to its kind. */
export function parseProxyConfig(kind: ProxyKind, config: unknown): unknown {
  return descriptorOf(kind).parseConfig(config);
}

export function proxyCapabilities(kind: ProxyKind, config: unknown): ProxyCapabilities {
  const descriptor = descriptorOf(kind);
  return descriptor.capabilities(descriptor.parseConfig(config));
}

/** A line for the screen: enough to recognize the connection. */
export function describeProxy(kind: ProxyKind, config: unknown): string {
  const descriptor = descriptorOf(kind);
  return descriptor.describe(descriptor.parseConfig(config));
}

/** The certificate authority set by Pupitre, to name it. */
export function proxyAcme(
  kind: ProxyKind,
  config: unknown,
): Pick<AcmeSettings, 'email' | 'server'> | null {
  const descriptor = descriptorOf(kind);
  return descriptor.acme(descriptor.parseConfig(config));
}
