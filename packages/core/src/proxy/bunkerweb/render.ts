import { stringify } from 'yaml';
import type { AcmeSettings, WafMode } from '../model.js';
import type { ProxyRoute } from '../types.js';

/**
 * Ce que Pupitre pose dans BunkerWeb — rendu pur, appliqué par le provider.
 *
 * ── Un service par domaine ──────────────────────────────────────────────────
 * BunkerWeb range sa configuration en « services », un par nom de serveur.
 * Pupitre en crée un par domaine, avec les seuls réglages qu'il gère : ceux
 * qu'un administrateur ajoute à la main dans l'interface de BunkerWeb (en-têtes,
 * règles de limite supplémentaires…) restent en place d'un déploiement à
 * l'autre — `PATCH` ne touche qu'aux variables envoyées.
 *
 * ── Les préréglages de protection ───────────────────────────────────────────
 * Les réglages par défaut de BunkerWeb sont faits pour un site vitrine : 2
 * requêtes par seconde **et par adresse, toutes URL confondues**, 10
 * connexions HTTP/1.1 simultanées par adresse, PUT et DELETE refusés, une
 * adresse bannie 24 h après dix erreurs en une minute. Mesuré : vingt
 * requêtes simultanées — une page et ses ressources — reçoivent dix-huit 429 ;
 * deux navigateurs derrière la même box dépassent les 10 connexions. Une
 * application web n'y survit pas ; d'où trois préréglages.
 */

/** Version épinglée : la série 1.6, correctifs compris par une montée explicite. */
export const BUNKERWEB_IMAGE = 'bunkerity/bunkerweb-all-in-one:1.6.15';
export const BUNKERWEB_PROJECT = 'pupitre-bunkerweb';
export const BUNKERWEB_CONTAINER = 'pupitre-bunkerweb';
export const BUNKERWEB_API_PORT = 8888;

/**
 * Le dossier de BunkerWeb sur la machine : `{racine du driver}/bunkerweb`. À
 * part de celui de Traefik (`{racine}/proxy`), que sa désinstallation efface.
 */
export function bunkerwebRoot(rootPath: string): string {
  return `${rootPath.replace(/\/+$/, '')}/bunkerweb`;
}

/**
 * Les sondes de Pupitre passent la liste blanche de BunkerWeb par un en-tête
 * secret, pas par leur adresse : vues du conteneur, elles arrivent de la
 * passerelle Docker — comme les visiteurs IPv6 que Docker relaie, qu'une
 * liste blanche par adresse soustrairait au WAF. Le secret vit sur la machine
 * du proxy, dans ce fichier (`Nom: valeur`, mode 600).
 */
export const PROBE_HEADER = 'X-Pupitre-Probe';
export function probeHeaderFile(rootPath: string): string {
  return `${bunkerwebRoot(rootPath)}/probe-header`;
}
/** Remplacé sur la machine par le secret, au moment de l'appel à l'API. */
export const PROBE_SECRET_PLACEHOLDER = '__PUPITRE_PROBE_SECRET__';

/** Les méthodes d'une application web, API REST comprises (BunkerWeb : GET|POST|HEAD). */
const WEB_METHODS = 'GET|POST|HEAD|QUERY|PUT|PATCH|DELETE|OPTIONS';

/**
 *   block   ModSecurity bloquant (règles OWASP CRS) ; 100 requêtes par seconde
 *           et par adresse — une page et ses ressources passent, le flot d'une
 *           seule adresse non ; 100 connexions simultanées par adresse — un
 *           bureau derrière une seule adresse passe ; bannissement d'une heure
 *           après trente erreurs en une minute, sans compter les 429 (dépasser
 *           la limite ne mène pas au bannissement) ;
 *   detect  les mêmes contrôles, en mode `detect` de BunkerWeb : tout est
 *           journalisé, rien n'est bloqué. Sans limite de connexions : nginx
 *           l'applique toujours, il ne sait pas seulement la journaliser ;
 *   off     plus d'inspection ni de limite ; BunkerWeb relaie.
 */
export function wafPreset(mode: WafMode): Record<string, string> {
  const inspection = {
    USE_MODSECURITY: 'yes',
    USE_MODSECURITY_CRS: 'yes',
    USE_LIMIT_REQ: 'yes',
    LIMIT_REQ_URL: '/',
    LIMIT_REQ_RATE: '100r/s',
    USE_BAD_BEHAVIOR: 'yes',
    BAD_BEHAVIOR_STATUS_CODES: '400 401 403 404 405 444',
    BAD_BEHAVIOR_THRESHOLD: '30',
    BAD_BEHAVIOR_COUNT_TIME: '60',
    BAD_BEHAVIOR_BAN_TIME: '3600',
    ALLOWED_METHODS: WEB_METHODS,
  };
  if (mode === 'block') {
    return {
      SECURITY_MODE: 'block',
      MODSECURITY_SEC_RULE_ENGINE: 'On',
      ...inspection,
      USE_LIMIT_CONN: 'yes',
      LIMIT_CONN_MAX_HTTP1: '100',
    };
  }
  if (mode === 'detect') {
    return {
      SECURITY_MODE: 'detect',
      MODSECURITY_SEC_RULE_ENGINE: 'DetectionOnly',
      ...inspection,
      USE_LIMIT_CONN: 'no',
    };
  }
  return {
    SECURITY_MODE: 'detect',
    USE_MODSECURITY: 'no',
    USE_LIMIT_REQ: 'no',
    USE_LIMIT_CONN: 'no',
    USE_BAD_BEHAVIOR: 'no',
    ALLOWED_METHODS: WEB_METHODS,
  };
}

/**
 * Les variables du service d'un domaine. `upstream` : `http://IP:port` — une
 * adresse IP, le nginx de BunkerWeb ne lisant pas `/etc/hosts`. Les sondes de
 * Pupitre passent la liste blanche par leur en-tête secret — jamais limitées
 * ni bannies, sans quoi un domaine sain passerait pour tombé ; la valeur est
 * `PROBE_SECRET_PLACEHOLDER`, remplacée sur la machine du proxy.
 */
export function serviceVariables(input: {
  route: ProxyRoute;
  upstream: string;
  acme: Pick<AcmeSettings, 'email' | 'server'> | null;
}): Record<string, string> {
  const { route, acme } = input;
  const letsEncrypt = route.tls && acme !== null;
  const redirect = route.tls && route.redirectHttps;
  return {
    SERVER_NAME: route.hostname,
    USE_REVERSE_PROXY: 'yes',
    REVERSE_PROXY_HOST: input.upstream,
    REVERSE_PROXY_URL: '/',
    AUTO_LETS_ENCRYPT: letsEncrypt ? 'yes' : 'no',
    // HTTPS sans autorité : un certificat auto-signé plutôt que rien.
    GENERATE_SELF_SIGNED_SSL: route.tls && !letsEncrypt ? 'yes' : 'no',
    EMAIL_LETS_ENCRYPT: acme?.email ?? '',
    LETS_ENCRYPT_SERVER: acme?.server === 'zerossl' ? 'zerossl' : 'letsencrypt',
    USE_LETS_ENCRYPT_STAGING: acme?.server === 'staging' ? 'yes' : 'no',
    REDIRECT_HTTP_TO_HTTPS: redirect ? 'yes' : 'no',
    AUTO_REDIRECT_HTTP_TO_HTTPS: redirect ? 'yes' : 'no',
    USE_WHITELIST: 'yes',
    WHITELIST_HEADER_NAME: PROBE_HEADER,
    WHITELIST_HEADER_VALUE: `^${PROBE_SECRET_PLACEHOLDER}$`,
    ...wafPreset(route.waf),
  };
}

/**
 * Ce que Pupitre a posé pour une application (et la machine d'où elle vient,
 * pour le proxy central) : la liste de ses domaines, gardée dans un fichier sur
 * la machine du proxy. C'est elle qui dit quoi retirer quand un domaine
 * disparaît, et quels services ne sont pas à Pupitre — BunkerWeb n'a pas
 * d'étiquette où le noter.
 */
export type RouteRegistry = { hostnames: string[] };

export function parseRegistry(text: string | null): RouteRegistry {
  if (!text?.trim()) return { hostnames: [] };
  try {
    const parsed = JSON.parse(text) as { hostnames?: unknown };
    return {
      hostnames: Array.isArray(parsed.hostnames)
        ? parsed.hostnames.filter((value): value is string => typeof value === 'string')
        : [],
    };
  } catch {
    return { hostnames: [] };
  }
}

/** Le nom du fichier du registre d'une application : `{slug}[--{portée}].json`. */
export function registryFileName(name: string): string {
  return `${name.replace(/[^a-z0-9-]/gi, '-')}.json`;
}

export type ServicePlan = {
  create: string[];
  update: string[];
  remove: string[];
  /** Des services qui existent déjà dans BunkerWeb sans être à Pupitre. */
  foreign: string[];
};

/**
 * Ce qu'il faut faire pour qu'une application ait exactement ces domaines.
 * `owned` : tous les domaines que Pupitre a posés sur ce BunkerWeb, toutes
 * applications confondues — un service existant hors de cette liste n'est pas
 * à lui, il n'y touche pas.
 */
export function planServices(input: {
  /** Les domaines que l'application doit avoir. */
  wanted: string[];
  /** Ceux que Pupitre lui avait posés. */
  previous: string[];
  /** Les services qui existent dans BunkerWeb. */
  existing: string[];
  /** Les domaines que Pupitre a posés pour les **autres** applications. */
  others: string[];
}): ServicePlan {
  const existing = new Set(input.existing);
  const others = new Set(input.others);
  const owned = new Set([...input.previous, ...input.others]);
  const wanted = new Set(input.wanted);
  const plan: ServicePlan = { create: [], update: [], remove: [], foreign: [] };
  for (const hostname of wanted) {
    if (!existing.has(hostname)) plan.create.push(hostname);
    else if (owned.has(hostname)) plan.update.push(hostname);
    else plan.foreign.push(hostname);
  }
  // Un domaine passé à une autre application est désormais le sien : on ne
  // retire que ce qui n'est plus réclamé par personne.
  for (const hostname of input.previous) {
    if (!wanted.has(hostname) && !others.has(hostname) && existing.has(hostname)) {
      plan.remove.push(hostname);
    }
  }
  return plan;
}

/**
 * Le BunkerWeb installé par Pupitre : le tout-en-un, ports 80 → 8080 et
 * 443 → 8443 (il tourne sans les droits root et écoute au-dessus de 1024),
 * l'API activée, l'interface web non — Pupitre en tient lieu. Le jeton de
 * l'API est dans `api.env`, généré sur la machine et lisible de son seul
 * propriétaire ; il n'apparaît pas ici.
 */
export function renderBunkerwebCompose(): string {
  return stringify(
    {
      name: BUNKERWEB_PROJECT,
      services: {
        bunkerweb: {
          image: BUNKERWEB_IMAGE,
          container_name: BUNKERWEB_CONTAINER,
          restart: 'unless-stopped',
          ports: ['80:8080/tcp', '443:8443/tcp'],
          env_file: ['./api.env'],
          environment: {
            SERVICE_API: 'yes',
            SERVICE_UI: 'no',
            SERVICE_SCHEDULER: 'yes',
            MULTISITE: 'yes',
            SERVER_NAME: '',
            API_LISTEN_PORT: String(BUNKERWEB_API_PORT),
            // Au réglage de nginx (64), un domaine d'une cinquantaine de
            // caractères fait refuser **toute** la configuration — BunkerWeb
            // revient alors en silence à la précédente.
            SERVER_NAMES_HASH_BUCKET_SIZE: '256',
          },
          volumes: ['bunkerweb-data:/data'],
          labels: { 'io.pupitre.managed': 'bunkerweb' },
        },
      },
      volumes: { 'bunkerweb-data': {} },
    },
    { lineWidth: 0 },
  );
}
