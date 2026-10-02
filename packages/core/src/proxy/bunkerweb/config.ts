import { z } from 'zod';
import { acmeSettingsSchema, type ProxyDescriptor } from '../model.js';
import type { ProbeSignatures } from '../probe.js';

/**
 * BunkerWeb — sa configuration de connexion, et ce qu'il dit de lui-même.
 * Rien n'est exécuté ici : l'écran l'importe, comme le worker.
 *
 * Pupitre le pilote par son API REST (`SERVICE_API=yes`), appelée **depuis sa
 * machine** par SSH. Le jeton de l'API n'est pas dans cette configuration : il
 * est lu dans le conteneur à chaque appel, sans jamais quitter la machine — ni
 * base, ni navigateur, ni journal.
 */

/** Les autorités que BunkerWeb sait interroger : Let's Encrypt et ZeroSSL, pas d'autre URL. */
export const BUNKERWEB_ACME_SERVERS = ['production', 'staging', 'zerossl'] as const;

export const bunkerwebConfigSchema = z.object({
  /** Le conteneur qui reçoit les visiteurs : le tout-en-un, ou `bunkerweb`. */
  container: z.string().min(1).max(128),
  /** Le conteneur de l'API — le même en tout-en-un. Son jeton y est lu à chaque appel. */
  apiContainer: z.string().min(1).max(128),
  apiPort: z.number().int().min(1).max(65_535).default(8888),
  /**
   * L'adresse IP par laquelle BunkerWeb joint un port publié sur sa machine :
   * la passerelle Docker, ou `127.0.0.1` en réseau hôte. Une IP et pas un nom :
   * son nginx résout par DNS, pas par `/etc/hosts`.
   */
  upstreamHost: z.string().min(1).max(255),
  /** Image du BunkerWeb installé par Pupitre. */
  image: z.string().max(200).nullable().default(null),
  /** Installé par Pupitre : sa désinstallation retire le conteneur et ses données. */
  managed: z.boolean().default(false),
  /** Renseigné quand Pupitre règle les certificats : réglé domaine par domaine. */
  acme: acmeSettingsSchema
    .refine((acme) => acme.server !== 'custom', {
      message: 'BunkerWeb n’accepte que Let’s Encrypt ou ZeroSSL',
    })
    .nullable()
    .default(null),
});
export type BunkerWebConfig = z.infer<typeof bunkerwebConfigSchema>;

const AUTHORITY: Record<string, string> = {
  production: 'Let’s Encrypt',
  staging: 'Let’s Encrypt (essai)',
  zerossl: 'ZeroSSL',
};

export const bunkerwebDescriptor: ProxyDescriptor<BunkerWebConfig> = {
  label: 'BunkerWeb',
  placement: 'target',
  parseConfig: (config) => bunkerwebConfigSchema.parse(config),
  describe(config) {
    const tls = config.acme ? `certificats ${AUTHORITY[config.acme.server]}` : 'sans ACME';
    return `BunkerWeb · conteneur ${config.container} · WAF · ${tls}`;
  },
  capabilities: (config) => ({
    autoTls: config.acme !== null,
    https: true,
    redirectHttps: true,
    waf: true,
    remoteUpstream: 'any',
  }),
  acme: (config) => (config.acme ? { email: config.acme.email, server: config.acme.server } : null),
};

/**
 * Ce que BunkerWeb sert à un nom qu'il ne connaît pas — sa page par défaut, en
 * **200** —, et le certificat auto-signé qu'il présente tant qu'il n'en a pas
 * obtenu un vrai.
 */
export const BUNKERWEB_PROBE: ProbeSignatures = {
  noRouteBody: 'utm_source=bwdefault',
  placeholderCertificate:
    /Internet Widgits Pty Ltd.*www\.example\.org|www\.example\.org.*Internet Widgits Pty Ltd/i,
};
