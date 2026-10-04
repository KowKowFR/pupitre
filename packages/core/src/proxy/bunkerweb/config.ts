import { z } from 'zod';
import { acmeSettingsSchema, type ProxyDescriptor } from '../model.js';
import type { ProbeSignatures } from '../probe.js';
import { bunkerwebSay } from './messages.js';

/**
 * BunkerWeb — its connection configuration, and what it says about itself.
 * Nothing runs here: the screen imports it, as does the worker.
 *
 * Pupitre drives it through its REST API (`SERVICE_API=yes`), called **from its
 * machine** over SSH. The API token is not in this configuration: it is read in
 * the container at each call, without ever leaving the machine — neither
 * database, nor browser, nor log.
 */

/** The authorities BunkerWeb can query: Let's Encrypt and ZeroSSL, no other URL. */
export const BUNKERWEB_ACME_SERVERS = ['production', 'staging', 'zerossl'] as const;

export const bunkerwebConfigSchema = z.object({
  /** The container that receives visitors: the all-in-one, or `bunkerweb`. */
  container: z.string().min(1).max(128),
  /** The API's container — the same with the all-in-one. Its token is read there at each call. */
  apiContainer: z.string().min(1).max(128),
  apiPort: z.number().int().min(1).max(65_535).default(8888),
  /**
   * The IP address through which BunkerWeb reaches a port published on its
   * machine: the Docker gateway, or `127.0.0.1` on the host network. An IP and
   * not a name: its nginx resolves through DNS, not through `/etc/hosts`.
   */
  upstreamHost: z.string().min(1).max(255),
  /** Image of the BunkerWeb installed by Pupitre. */
  image: z.string().max(200).nullable().default(null),
  /** Installed by Pupitre: its uninstall removes the container and its data. */
  managed: z.boolean().default(false),
  /** Filled in when Pupitre sets the certificates: set domain by domain. */
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
  zerossl: 'ZeroSSL',
};

export const bunkerwebDescriptor: ProxyDescriptor<BunkerWebConfig> = {
  label: 'BunkerWeb',
  placement: 'target',
  parseConfig: (config) => bunkerwebConfigSchema.parse(config),
  describe(config, language) {
    const say = bunkerwebSay(language);
    const authority =
      config.acme?.server === 'staging'
        ? say('describe.staging')
        : AUTHORITY[config.acme?.server ?? ''];
    const tls = authority ? say('describe.certificates', { authority }) : say('describe.noAcme');
    return `BunkerWeb · ${say('describe.container', { name: config.container })} · WAF · ${tls}`;
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
 * What BunkerWeb serves to a name it does not know — its default page, as a
 * **200** —, and the self-signed certificate it presents until it has obtained
 * a real one.
 */
export const BUNKERWEB_PROBE: ProbeSignatures = {
  noRouteBody: 'utm_source=bwdefault',
  placeholderCertificate:
    /Internet Widgits Pty Ltd.*www\.example\.org|www\.example\.org.*Internet Widgits Pty Ltd/i,
};
