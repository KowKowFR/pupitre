import { z } from 'zod';
import { invalid } from '../../validation.js';
import type { ProxyDescriptor } from '../model.js';
import type { ProbeSignatures } from '../probe.js';

/**
 * Nginx Proxy Manager — its connection, and what it says about itself. Nothing
 * runs here: the screen imports it, as does the worker.
 *
 * A **remote** proxy: it runs outside the targets, often on a separate machine
 * that serves a whole network. Pupitre does not drive that machine; it talks to
 * NPM's API, with an account of its own. The account's email is shown; its
 * password is a secret, encrypted in the database, that only goes out toward
 * the worker.
 */

const port = z.number().int().min(1).max(65_535);

/** `http://10.0.0.5:81/` ou `…/api` → `http://10.0.0.5:81` : l'adresse de l'interface. */
function interfaceUrl(value: string): string {
  return value
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/api$/, '');
}

export const npmConfigSchema = z.object({
  /** The address of its admin interface, which also carries the API: `http://10.0.0.5:81`. */
  url: z
    .string()
    .trim()
    .url()
    .max(500)
    .refine((value) => /^https?:\/\//i.test(value), invalid('npm.url'))
    .transform(interfaceUrl),
  /** The account Pupitre uses. */
  email: z.string().trim().email().max(254),
  /**
   * Where NPM receives visitors: that is where domains are probed, from the panel.
   * By default, its interface's machine, ports 80 and 443.
   */
  entrypoint: z
    .object({
      host: z.string().trim().min(1).max(255),
      httpPort: port.default(80),
      httpsPort: port.default(443),
    })
    .nullable()
    .default(null),
});
export type NpmConfig = z.infer<typeof npmConfigSchema>;

export const npmSecretsSchema = z.object({
  password: z.string().min(1).max(500),
});

/** Where to probe: the set entrance, otherwise the interface's machine. */
export function npmEntrypoint(config: NpmConfig): {
  host: string;
  httpPort: number;
  httpsPort: number;
} {
  return config.entrypoint ?? { host: new URL(config.url).hostname, httpPort: 80, httpsPort: 443 };
}

export const npmDescriptor: ProxyDescriptor<NpmConfig> = {
  label: 'Nginx Proxy Manager',
  placement: 'remote',
  parseConfig: (config) => npmConfigSchema.parse(config),
  parseSecrets: (secrets) => npmSecretsSchema.parse(secrets),
  entrypointHost: (config) => npmEntrypoint(config).host,
  describe: (config) =>
    `Nginx Proxy Manager · ${new URL(config.url).host} · compte ${config.email}`,
  capabilities: () => ({
    // NPM requests its certificates from Let's Encrypt itself, in the account's
    // name.
    autoTls: true,
    https: true,
    redirectHttps: true,
    waf: false,
    remoteUpstream: 'any',
  }),
  // Its authority is its own (Let's Encrypt, or what its instance sets): Pupitre
  // does not choose it, so it does not name it.
  acme: () => null,
};

/**
 * What NPM serves to a name it does not know: its "Congratulations" page as a
 * 200 — as long as its "default site" was not changed. Over HTTPS, it refuses
 * the handshake; its placeholder certificate is no longer seen.
 */
export const NPM_PROBE: ProbeSignatures = {
  noRouteBody: 'successfully started the Nginx Proxy Manager',
  placeholderCertificate: /Dummy Certificate/i,
};
