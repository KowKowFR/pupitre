import { z } from 'zod';
import { acmeSettingsSchema, type ProxyDescriptor } from '../model.js';
import type { ProbeSignatures } from '../probe.js';

/**
 * Traefik — sa configuration de connexion, et ce qu'il dit de lui-même.
 * Rien n'est exécuté ici : l'écran l'importe, comme le worker.
 */

const entryPointsSchema = z.object({
  /** Le point d'entrée HTTP (port 80) : `web` par convention. */
  http: z.string().min(1).max(64).default('web'),
  /** Le point d'entrée HTTPS (port 443), ou `null` si ce Traefik n'en a pas. */
  https: z.string().min(1).max(64).nullable().default('websecure'),
});

/**
 * Traefik, deux façons d'être piloté — ce sont ses propres « providers » :
 *   file        un dossier surveillé par Traefik ; Pupitre y dépose un fichier
 *               par application. Traefik en conteneur ou en binaire.
 *   kubernetes  des objets Ingress dans le cluster ; le Traefik de K3s.
 * Le choix suit l'installation trouvée sur la machine, pas le runtime des
 * applications : c'est une propriété du proxy.
 */
const traefikCommon = {
  entryPoints: entryPointsSchema.default({ http: 'web', https: 'websecure' }),
  /** Le résolveur de certificats à demander, ou `null` : HTTPS avec le certificat par défaut. */
  certResolver: z.string().min(1).max(64).nullable().default(null),
  /** Renseigné quand Pupitre a installé (ou configuré) ce Traefik. */
  acme: acmeSettingsSchema.nullable().default(null),
};

export const traefikFileConfigSchema = z.object({
  mode: z.literal('file'),
  /** Dossier surveillé, sur la machine. `null` : `{racine du driver}/proxy/dynamic`. */
  directory: z.string().min(1).max(500).nullable().default(null),
  /**
   * L'adresse à laquelle Traefik joint un port publié : `127.0.0.1` pour un
   * Traefik en réseau hôte, la passerelle de son réseau sinon.
   */
  upstreamHost: z.string().min(1).max(255).default('127.0.0.1'),
  /** Le conteneur, quand Traefik en est un — pour le retrouver et le dire. */
  container: z.string().max(128).nullable().default(null),
  /** Image du Traefik installé par Pupitre. */
  image: z.string().max(200).nullable().default(null),
  ...traefikCommon,
});

export const traefikKubernetesConfigSchema = z.object({
  mode: z.literal('kubernetes'),
  ingressClass: z.string().min(1).max(253).default('traefik'),
  /** Où vit le déploiement de Traefik, pour le sonder. */
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
  describe(config) {
    const tls = config.certResolver ? `certificats « ${config.certResolver} »` : 'sans ACME';
    if (config.mode === 'kubernetes') {
      return `Traefik du cluster · IngressClass ${config.ingressClass} · ${tls}`;
    }
    const where = config.container ? `conteneur ${config.container}` : 'fichiers';
    return `Traefik · ${where} · ${tls}`;
  },
  capabilities(config) {
    const https = config.entryPoints.https !== null;
    return {
      autoTls: https && config.certResolver !== null,
      https,
      redirectHttps: https,
      waf: false,
      // Le Traefik d'un cluster joint une autre machine par une EndpointSlice : une IPv4.
      remoteUpstream: config.mode === 'kubernetes' ? 'ipv4' : 'any',
    };
  },
  acme: (config) => (config.acme ? { email: config.acme.email, server: config.acme.server } : null),
};

/** Ce que Traefik répond à un nom inconnu, et le certificat qu'il sert en attendant. */
export const TRAEFIK_PROBE: ProbeSignatures = {
  noRouteBody: '404 page not found',
  placeholderCertificate: /TRAEFIK DEFAULT CERT/i,
};
