import { z } from 'zod';

/**
 * Les reverse proxies — le vocabulaire, sans rien exécuter.
 *
 * Ce module est importé par l'écran comme par le worker : il ne touche ni à SSH
 * ni au réseau. Ce qui parle à une machine vit sous `@pupitre/core/proxy`.
 *
 * ── Trois notions, et pas une de plus ───────────────────────────────────────
 *   la connexion   un proxy que le panel sait piloter : son genre, où il est,
 *                  comment le joindre. Rangée en base, une par machine pour un
 *                  proxy « sur la cible ».
 *   la route       un nom de domaine qui mène à une application sur une cible.
 *                  Rangée en base, unique par nom : deux applications ne
 *                  peuvent pas réclamer le même domaine, et c'est une
 *                  contrainte, pas un `if`.
 *   l'amont        ce par quoi le proxy joint l'application. C'est le driver
 *                  qui le dit — un port publié, un Service Kubernetes — parce
 *                  que lui seul sait comment il expose.
 */

/** Les genres connus de la base. Chacun déclare sa configuration dans `catalog.ts`. */
export const PROXY_KINDS = ['traefik', 'bunkerweb'] as const;
export const proxyKindSchema = z.enum(PROXY_KINDS);
export type ProxyKind = z.infer<typeof proxyKindSchema>;

/**
 * `target` : le proxy tourne sur la machine qu'il sert — le cas de Traefik.
 * `remote` : il est ailleurs et en sert plusieurs — prévu pour les proxies
 * centraux. Le modèle le porte dès maintenant pour ne pas avoir à le refaire.
 */
export const PROXY_PLACEMENTS = ['target', 'remote'] as const;
export const proxyPlacementSchema = z.enum(PROXY_PLACEMENTS);
export type ProxyPlacement = z.infer<typeof proxyPlacementSchema>;

export const PROXY_STATUSES = ['unknown', 'installing', 'ok', 'failed'] as const;
export type ProxyStatus = (typeof PROXY_STATUSES)[number];

export const ROUTE_STATUSES = ['pending', 'active', 'failed'] as const;
export type RouteStatus = (typeof ROUTE_STATUSES)[number];

// ─── les noms de domaine ─────────────────────────────────────────────────────

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * Un nom d'hôte tel qu'un proxy le route : en minuscules, sans point final,
 * au moins deux libellés, pas d'adresse IP, pas de joker. Le joker viendra
 * avec les certificats DNS-01 ; une adresse IP n'a pas de certificat public.
 */
export function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

export function hostnameProblem(value: string): string | null {
  const host = normalizeHostname(value);
  if (host.length === 0) return 'vide';
  if (host.length > 253) return 'plus de 253 caractères';
  if (host.includes('*')) return 'les jokers ne sont pas pris en charge';
  if (/^[0-9.]+$/.test(host) || host.includes(':')) return 'une adresse IP n’est pas un domaine';
  const labels = host.split('.');
  if (labels.length < 2) return 'il faut au moins un point (exemple.fr)';
  if (!labels.every((label) => LABEL.test(label))) return 'caractère ou libellé invalide';
  return null;
}

export const hostnameSchema = z
  .string()
  .max(260)
  .transform(normalizeHostname)
  .superRefine((host, context) => {
    const problem = hostnameProblem(host);
    if (problem) context.addIssue({ code: 'custom', message: `« ${host} » : ${problem}` });
  });

/**
 * La protection d'un domaine par un proxy qui est aussi un pare-feu applicatif
 * (WAF). Sans objet pour un proxy qui n'en est pas un — il l'ignore.
 *   block   les attaques reconnues sont bloquées, les abus limités ;
 *   detect  tout est inspecté et journalisé, rien n'est bloqué — pour
 *           s'assurer qu'une application n'en souffre pas avant de bloquer ;
 *   off     le proxy relaie, sans inspecter.
 */
export const WAF_MODES = ['block', 'detect', 'off'] as const;
export const wafModeSchema = z.enum(WAF_MODES);
export type WafMode = z.infer<typeof wafModeSchema>;

/** Ce qu'on demande pour un domaine : le reste se déduit du proxy. */
export const routeInputSchema = z.object({
  hostname: hostnameSchema,
  /** Servi en HTTPS, certificat obtenu par le proxy. */
  tls: z.boolean().default(true),
  /** HTTP renvoie vers HTTPS. Sans objet sans `tls`. */
  redirectHttps: z.boolean().default(true),
  /** La protection du domaine, pour un proxy qui est aussi un WAF. */
  waf: wafModeSchema.default('block'),
});
export type RouteInput = z.infer<typeof routeInputSchema>;

/** Les domaines d'une application sur une cible : la liste entière, sans doublon. */
export const routeListSchema = z
  .array(routeInputSchema)
  .max(20)
  .superRefine((routes, context) => {
    const seen = new Set<string>();
    for (const route of routes) {
      if (seen.has(route.hostname)) {
        context.addIssue({ code: 'custom', message: `« ${route.hostname} » apparaît deux fois` });
      }
      seen.add(route.hostname);
    }
  });

// ─── le certificat servi ─────────────────────────────────────────────────────

/**
 * Ce que le proxy présente pour un domaine, lu depuis la machine du proxy.
 *   none     la route n'est pas en HTTPS ;
 *   pending  le proxy sert son certificat par défaut — l'émission n'a pas
 *            encore abouti (DNS pas encore propagé, port 80 fermé…) ;
 *   valid    un vrai certificat, pour ce nom, pas expiré ;
 *   invalid  un certificat, mais expiré ou pour un autre nom ;
 *   unknown  la lecture a échoué : ni outil, ni réponse.
 */
export const CERTIFICATE_STATUSES = ['none', 'pending', 'valid', 'invalid', 'unknown'] as const;
export type CertificateStatus = (typeof CERTIFICATE_STATUSES)[number];

export const routeCertificateSchema = z.object({
  status: z.enum(CERTIFICATE_STATUSES),
  issuer: z.string().nullable().default(null),
  subject: z.string().nullable().default(null),
  notAfter: z.string().nullable().default(null),
});
export type RouteCertificate = z.infer<typeof routeCertificateSchema>;

// ─── l'amont ─────────────────────────────────────────────────────────────────

/**
 * Par où le proxy joint l'application. Fourni par le driver : c'est lui qui
 * sait si son runtime publie un port sur la machine ou un Service dans un
 * cluster. Le proxy dit lequel il sait atteindre ; le pipeline n'a pas à
 * savoir sur quel runtime il tourne.
 */
export type ProxyUpstream =
  /**
   * Un port publié sur une machine. Sans `host`, celle du proxy — il la joint
   * à son adresse locale. Avec `host`, une **autre** machine, que le proxy
   * joint par cette adresse : c'est le proxy central.
   */
  | { kind: 'port'; port: number; host?: string }
  | { kind: 'kubernetes'; namespace: string; service: string; port: number };

/** Une adresse privée (RFC 1918, ULA, boucle locale) : le trafic en clair y reste. */
export function isPrivateAddress(address: string): boolean {
  if (/^10\.|^192\.168\.|^127\.|^169\.254\./.test(address)) return true;
  const match = /^172\.(\d+)\./.exec(address);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address)) return true; // CGNAT, Tailscale
  return /^(fc|fd)[0-9a-f]{2}:|^::1$/i.test(address);
}

export function isIPv4(address: string): boolean {
  return /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(address);
}

// ─── les certificats ─────────────────────────────────────────────────────────

/**
 * L'autorité de certification qu'un proxy installé par Pupitre interroge.
 * Tous ne les acceptent pas toutes : chaque option d'installation dit
 * lesquelles (`ProxyInstallOption.acmeServers`).
 */
export const ACME_SERVERS = ['production', 'staging', 'zerossl', 'custom'] as const;
export type AcmeServer = (typeof ACME_SERVERS)[number];
export const acmeSettingsSchema = z.object({
  email: z.string().email().max(254),
  server: z.enum(ACME_SERVERS).default('production'),
  /** Avec `custom` : un ACME interne (step-ca, Smallstep…), ou Pebble en test. */
  customUrl: z.string().url().max(500).nullable().default(null),
  /** L'autorité qui signe l'URL ACME elle-même, quand elle n'est pas publique (PEM). */
  caCertificate: z.string().max(20_000).nullable().default(null),
});
export type AcmeSettings = z.infer<typeof acmeSettingsSchema>;

export const ACME_DIRECTORIES: Record<Exclude<AcmeServer, 'custom'>, string> = {
  production: 'https://acme-v02.api.letsencrypt.org/directory',
  staging: 'https://acme-staging-v02.api.letsencrypt.org/directory',
  zerossl: 'https://acme.zerossl.com/v2/DV90',
};

export function acmeDirectory(acme: AcmeSettings): string {
  if (acme.server === 'custom') {
    if (!acme.customUrl) throw new Error('serveur ACME personnalisé sans URL');
    return acme.customUrl;
  }
  return ACME_DIRECTORIES[acme.server];
}

// ─── ce qu'un proxy sait faire ───────────────────────────────────────────────

/**
 * Ce qu'un proxy sait faire, pour que l'écran ne propose que cela et que l'API
 * refuse le reste. On demande au proxy ce qu'il sait faire, pas lequel il
 * est — même règle que pour le pare-feu des drivers.
 */
export type ProxyCapabilities = {
  /** Il obtient lui-même les certificats (ACME). */
  autoTls: boolean;
  /** Il sait servir en HTTPS, même avec un certificat par défaut. */
  https: boolean;
  /** Il sait renvoyer HTTP vers HTTPS. */
  redirectHttps: boolean;
  /** Il est aussi un pare-feu applicatif : chaque domaine a sa protection (`WafMode`). */
  waf: boolean;
  /**
   * Comment il joint une autre machine — le proxy central : par toute adresse,
   * par une IPv4 seulement, ou pas du tout.
   */
  remoteUpstream: 'any' | 'ipv4' | 'none';
};

/**
 * Ce qu'un genre de proxy déclare de lui-même, sans rien exécuter : lire sa
 * configuration, se décrire, dire ce qu'il sait faire. L'écran et l'API s'en
 * servent ; ajouter un proxy, c'est en écrire un (`catalog.ts`).
 */
export type ProxyDescriptor<C = unknown> = {
  /** Le nom du genre, pour l'écran : « Traefik », « BunkerWeb ». */
  label: string;
  parseConfig(config: unknown): C;
  /** Une ligne pour l'écran : de quoi reconnaître la connexion. */
  describe(config: C): string;
  capabilities(config: C): ProxyCapabilities;
  /** L'autorité de certification réglée par Pupitre, pour la dire ; `null` sinon. */
  acme(config: C): Pick<AcmeSettings, 'email' | 'server'> | null;
};
