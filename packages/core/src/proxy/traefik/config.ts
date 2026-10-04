import { z } from 'zod';
import { acmeSettingsSchema, type ProxyDescriptor } from '../model.js';
import type { ProbeSignatures } from '../probe.js';
import { traefikSay } from './messages.js';

/**
 * Traefik — its connection configuration, and what it says about itself.
 * Nothing runs here: the screen imports it, as does the worker.
 */

const entryPointsSchema = z.object({
  /** The HTTP entry point (port 80): `web` by convention. */
  http: z.string().min(1).max(64).default('web'),
  /** The HTTPS entry point (port 443), or `null` if this Traefik has none. */
  https: z.string().min(1).max(64).nullable().default('websecure'),
});

/**
 * Traefik, two ways of being driven — they are its own "providers":
 *   file        a folder watched by Traefik; Pupitre places one file per
 *               application in it. Traefik in a container or as a binary.
 *   kubernetes  Ingress objects in the cluster; K3s's Traefik.
 * The choice follows the installation found on the machine, not the
 * applications' runtime: it is a property of the proxy.
 */
const traefikCommon = {
  entryPoints: entryPointsSchema.default({ http: 'web', https: 'websecure' }),
  /** The certificate resolver to request, or `null`: HTTPS with the default certificate. */
  certResolver: z.string().min(1).max(64).nullable().default(null),
  /** Filled in when Pupitre installed (or configured) this Traefik. */
  acme: acmeSettingsSchema.nullable().default(null),
};

export const traefikFileConfigSchema = z.object({
  mode: z.literal('file'),
  /** Watched folder, on the machine. `null`: `{driver root}/proxy/dynamic`. */
  directory: z.string().min(1).max(500).nullable().default(null),
  /**
   * The address at which Traefik reaches a published port: `127.0.0.1` for a
   * Traefik on the host network, its network's gateway otherwise.
   */
  upstreamHost: z.string().min(1).max(255).default('127.0.0.1'),
  /** The container, when Traefik is one — to find it again and report it. */
  container: z.string().max(128).nullable().default(null),
  /** Image of the Traefik installed by Pupitre. */
  image: z.string().max(200).nullable().default(null),
  ...traefikCommon,
});

export const traefikKubernetesConfigSchema = z.object({
  mode: z.literal('kubernetes'),
  ingressClass: z.string().min(1).max(253).default('traefik'),
  /** Where Traefik's deployment lives, to probe it. */
  namespace: z.string().min(1).max(63).default('kube-system'),
  ...traefikCommon,
});

export const traefikConfigSchema = z.discriminatedUnion('mode', [
  traefikFileConfigSchema,
  traefikKubernetesConfigSchema,
]);
export type TraefikConfig = z.infer<typeof traefikConfigSchema>;
export type TraefikFileConfig = z.infer<typeof traefikFileConfigSchema>;
export type TraefikKubernetesConfig = z.infer<typeof traefikKubernetesConfigSchema>;

export const traefikDescriptor: ProxyDescriptor<TraefikConfig> = {
  label: 'Traefik',
  placement: 'target',
  parseConfig: (config) => traefikConfigSchema.parse(config),
  describe(config, language) {
    const say = traefikSay(language);
    const tls = config.certResolver
      ? say('describe.resolver', { resolver: config.certResolver })
      : say('describe.noAcme');
    if (config.mode === 'kubernetes') {
      return `${say('describe.cluster', { ingressClass: config.ingressClass })} · ${tls}`;
    }
    const where = config.container
      ? say('describe.container', { name: config.container })
      : say('describe.files');
    return `Traefik · ${where} · ${tls}`;
  },
  capabilities(config) {
    const https = config.entryPoints.https !== null;
    return {
      autoTls: https && config.certResolver !== null,
      https,
      redirectHttps: https,
      waf: false,
      // A cluster's Traefik reaches another machine through an EndpointSlice: an IPv4.
      remoteUpstream: config.mode === 'kubernetes' ? 'ipv4' : 'any',
    };
  },
  acme: (config) => (config.acme ? { email: config.acme.email, server: config.acme.server } : null),
};

/** What Traefik answers to an unknown name, and the certificate it serves meanwhile. */
export const TRAEFIK_PROBE: ProbeSignatures = {
  noRouteBody: '404 page not found',
  placeholderCertificate: /TRAEFIK DEFAULT CERT/i,
};
