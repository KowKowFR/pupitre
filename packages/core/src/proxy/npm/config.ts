import { z } from 'zod';
import type { ProxyDescriptor } from '../model.js';
import type { ProbeSignatures } from '../probe.js';

/**
 * Nginx Proxy Manager — sa connexion, et ce qu'il dit de lui-même. Rien n'est
 * exécuté ici : l'écran l'importe, comme le worker.
 *
 * Un proxy **distant** : il tourne hors des cibles, souvent sur une machine à
 * part qui sert tout un réseau. Pupitre ne la pilote pas ; il parle à l'API de
 * NPM, avec un compte à lui. L'e-mail du compte se montre ; son mot de passe
 * est un secret, chiffré en base, qui ne sort que vers le worker.
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
  /** L'adresse de son interface d'administration, qui porte aussi l'API : `http://10.0.0.5:81`. */
  url: z
    .string()
    .trim()
    .url()
    .max(500)
    .refine((value) => /^https?:\/\//i.test(value), {
      message: 'une adresse http:// ou https://',
    })
    .transform(interfaceUrl),
  /** Le compte que Pupitre emploie. */
  email: z.string().trim().email().max(254),
  /**
   * Où NPM reçoit les visiteurs : c'est là que les domaines sont sondés, depuis
   * le panel. Par défaut, la machine de son interface, ports 80 et 443.
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

/** Où sonder : l'entrée réglée, sinon la machine de l'interface. */
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
    // NPM demande lui-même ses certificats à Let's Encrypt, au nom du compte.
    autoTls: true,
    https: true,
    redirectHttps: true,
    waf: false,
    remoteUpstream: 'any',
  }),
  // Son autorité est la sienne (Let's Encrypt, ou ce que son instance règle) :
  // Pupitre ne la choisit pas, il ne la dit donc pas.
  acme: () => null,
};

/**
 * Ce que NPM sert à un nom qu'il ne connaît pas : sa page « Congratulations »
 * en 200 — tant que son « site par défaut » n'a pas été changé. En HTTPS, il
 * refuse la poignée de main ; son certificat d'attente ne se voit plus.
 */
export const NPM_PROBE: ProbeSignatures = {
  noRouteBody: 'successfully started the Nginx Proxy Manager',
  placeholderCertificate: /Dummy Certificate/i,
};
