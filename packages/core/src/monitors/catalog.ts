import { z } from 'zod';
import { monitorHostSchema, monitorUrlSchema } from './ssrf.js';

/**
 * Catalogue des types de sonde.
 *
 * ── La forme, et pourquoi celle-là ──────────────────────────────────────────
 * Superviser un site, ce n'est pas une chose mais six : disponibilité HTTP,
 * mot-clé dans la page, certificat TLS, enregistrements DNS, expiration de
 * domaine, empreinte de contenu. Ce ne sont pas six fonctionnalités — c'est
 * **une abstraction et six implémentations**, exactement la forme de `Scanner`
 * et de `DeploymentDriver`.
 *
 * D'où ce catalogue, sur le motif de `ai/catalog.ts` : une table de **données**
 * qui décrit, pour chaque type, son schéma de configuration, les champs que
 * l'écran doit afficher, les mesures qu'il rend, et sa cadence minimale. L'UI
 * se construit à partir de cette table ; il n'existe nulle part de
 * `if (type === 'http')`.
 *
 * La configuration propre à un type vit dans une colonne **JSONB** validée par
 * le schéma Zod du type — pas dans des colonnes dédiées à HTTP. La table
 * `monitors` ne porte que le commun : le type, la cadence, l'état, les seuils
 * de confirmation, le rattachement éventuel à une application.
 *
 * ── Deux conséquences, traitées ici ─────────────────────────────────────────
 *
 * 1. **La cadence dépend du type.** Une sonde HTTP à la minute est
 *    raisonnable ; interroger l'expiration d'un domaine toutes les minutes ne
 *    l'est pas — un domaine n'expire pas entre deux minutes, et ça harcèlerait
 *    les registres pour rien. Chaque type porte donc son `minIntervalSeconds`,
 *    et la validation le fait respecter.
 *
 * 2. **Les mesures dépendent du type.** Une sonde HTTP rend une latence et un
 *    code ; une sonde TLS rend des jours restants et un émetteur. Rien n'est
 *    forcé dans des colonnes HTTP : le résultat porte un espace de mesures
 *    structuré (`metrics`), et le catalogue dit à l'écran comment l'afficher.
 *
 * ── Ajouter un type ─────────────────────────────────────────────────────────
 * Une entrée ici, une implémentation sous `@pupitre/core/probe`, une ligne dans le
 * registre des sondes. Ni la table, ni le runner, ni les routes, ni l'écran ne
 * changent. `monitors.type` est volontairement du `text` et non un enum
 * Postgres : un enum ajouterait une migration à cette liste, et c'est
 * précisément la chirurgie qu'on veut éviter. Le vocabulaire reste fermé — il
 * est ici, et Zod le fait respecter à chaque entrée.
 */

export const MONITOR_TYPES_LIST = ['http', 'tls'] as const;
export const monitorTypeSchema = z.enum(MONITOR_TYPES_LIST);
export type MonitorType = z.infer<typeof monitorTypeSchema>;

// ─── description des champs, pour que l'écran se construise tout seul ─────────

export type ConfigFieldBase = {
  key: string;
  label: string;
  hint?: string;
  /** Un champ optionnel peut être laissé vide ; sa valeur est alors `null`. */
  optional?: boolean;
  /** Champ de réglage fin, replié derrière « Options avancées ». */
  advanced?: boolean;
};

export type ConfigField = ConfigFieldBase &
  (
    | { kind: 'url'; placeholder: string }
    | { kind: 'host'; placeholder: string }
    | { kind: 'text'; placeholder?: string }
    | { kind: 'number'; min: number; max: number; step?: number; unit?: string }
    | { kind: 'select'; options: ReadonlyArray<{ value: string; label: string }> }
  );

/** Comment afficher une mesure. L'écran ne connaît que ces formes. */
export type MetricDescriptor = {
  key: string;
  label: string;
  kind: 'duration-ms' | 'days' | 'number' | 'text' | 'http-status';
  /** Mise en avant dans la liste, à côté de l'état. */
  primary?: boolean;
};

export type MonitorTypeDefinition<Config> = {
  type: MonitorType;
  label: string;
  /** Ce que ce type constate, en une phrase. */
  description: string;
  /** Ce qu'il **ne** constate **pas** — affiché dans l'écran, à dessein. */
  neverDoes: string;
  schema: z.ZodType<Config>;
  fields: readonly ConfigField[];
  metrics: readonly MetricDescriptor[];
  /**
   * Cadence minimale, en secondes. Par type parce que c'est une propriété du
   * type : ce qu'il coûte à l'autre bout, et la vitesse à laquelle ce qu'il
   * observe peut changer.
   */
  minIntervalSeconds: number;
  defaultIntervalSeconds: number;
  /** Valeurs de départ du formulaire. */
  defaults: Config;
  /** La cible, en une ligne, pour une liste. */
  describeTarget: (config: Config) => string;
  /** Lien cliquable vers la cible, quand ça a un sens. */
  linkFor: (config: Config) => string | null;
  /** Comment le taux de disponibilité de ce type se lit. */
  uptimeMeans: string;
};

// ─── http ─────────────────────────────────────────────────────────────────────

export const HTTP_METHODS = ['GET', 'HEAD', 'POST'] as const;
export const httpMethodSchema = z.enum(HTTP_METHODS);
export type HttpMethod = z.infer<typeof httpMethodSchema>;

export const httpConfigSchema = z.object({
  url: monitorUrlSchema,
  method: httpMethodSchema.default('GET'),
  expectedStatus: z.number().int().min(100).max(599).default(200),
  /**
   * Mot-clé à trouver dans le corps. Option de la sonde HTTP, et non type à
   * part : c'est la même requête, on regarde simplement une chose de plus.
   */
  keyword: z.string().trim().min(1).max(200).nullable().default(null),
  timeoutMs: z.number().int().min(1_000).max(30_000).default(10_000),
});

export type HttpConfig = z.infer<typeof httpConfigSchema>;

const httpDefinition: MonitorTypeDefinition<HttpConfig> = {
  type: 'http',
  label: 'Disponibilité HTTP',
  description:
    "Une requête depuis le worker vers l'URL publique : code de réponse, temps de " +
    "réponse, et, si on le demande, présence d'un mot-clé dans la page.",
  neverDoes:
    "Ne redémarre rien, ne redéploie rien. C'est un constat, pas une action.",
  schema: httpConfigSchema,
  fields: [
    { key: 'url', kind: 'url', label: 'URL', placeholder: 'https://exemple.fr/' },
    {
      key: 'method',
      kind: 'select',
      label: 'Méthode',
      advanced: true,
      options: HTTP_METHODS.map((method) => ({ value: method, label: method })),
      hint: "HEAD évite de télécharger la page — mais interdit la recherche d'un mot-clé.",
    },
    {
      key: 'expectedStatus',
      kind: 'number',
      label: 'Code attendu',
      min: 100,
      max: 599,
      advanced: true,
    },
    {
      key: 'keyword',
      kind: 'text',
      label: 'Mot-clé attendu',
      optional: true,
      placeholder: 'facultatif',
      hint: "Cherché dans les 256 premiers kio de la réponse. Absent = la sonde échoue.",
    },
    {
      key: 'timeoutMs',
      kind: 'number',
      label: "Délai d'expiration",
      min: 1_000,
      max: 30_000,
      step: 500,
      unit: 'ms',
      advanced: true,
    },
  ],
  metrics: [
    { key: 'latencyMs', label: 'Temps de réponse', kind: 'duration-ms', primary: true },
    { key: 'httpStatus', label: 'Code HTTP', kind: 'http-status', primary: true },
    { key: 'redirects', label: 'Redirections suivies', kind: 'number' },
    { key: 'address', label: 'Adresse jointe', kind: 'text' },
  ],
  // Trente secondes : en dessous, une sonde coûte plus au worker qu'elle ne
  // rapporte, et la série temporelle double pour détecter une panne trois
  // secondes plus tôt.
  minIntervalSeconds: 30,
  defaultIntervalSeconds: 60,
  defaults: {
    url: '',
    method: 'GET',
    expectedStatus: 200,
    keyword: null,
    timeoutMs: 10_000,
  },
  describeTarget: (config) => config.url,
  linkFor: (config) => (config.url === '' ? null : config.url),
  uptimeMeans: "part du temps où l'URL a répondu le code attendu",
};

// ─── tls ──────────────────────────────────────────────────────────────────────

export const tlsConfigSchema = z.object({
  host: monitorHostSchema,
  port: z.number().int().min(1).max(65_535).default(443),
  /**
   * Nom présenté en SNI, quand il diffère de l'hôte joint. Utile pour vérifier
   * le certificat d'un vhost derrière une adresse partagée.
   */
  servername: z.string().trim().min(1).max(253).nullable().default(null),
  /**
   * Préavis, en jours. Ce **n'est pas** un simple avertissement : en deçà, la
   * sonde passe en échec. Une sonde de certificat n'a d'intérêt que si elle
   * alerte *avant* la panne ; attendre l'expiration reviendrait à constater
   * l'incendie. Le taux de disponibilité d'une sonde TLS se lit donc « part du
   * temps où le certificat était valide **et pas en fin de vie** ».
   */
  warnDays: z.number().int().min(1).max(180).default(21),
  timeoutMs: z.number().int().min(1_000).max(30_000).default(10_000),
});

export type TlsConfig = z.infer<typeof tlsConfigSchema>;

const tlsDefinition: MonitorTypeDefinition<TlsConfig> = {
  type: 'tls',
  label: 'Certificat TLS',
  description:
    "Une poignée de main TLS depuis le worker : date d'expiration, émetteur, " +
    'version du protocole. Prévient la panne la plus bête et la plus totale qui ' +
    'soit — un certificat expiré, que personne ne voit venir.',
  neverDoes: 'Ne renouvelle aucun certificat et ne touche à aucune configuration.',
  schema: tlsConfigSchema,
  fields: [
    { key: 'host', kind: 'host', label: 'Hôte', placeholder: 'exemple.fr' },
    { key: 'port', kind: 'number', label: 'Port', min: 1, max: 65_535 },
    {
      key: 'servername',
      kind: 'text',
      label: 'Nom SNI',
      optional: true,
      advanced: true,
      placeholder: "identique à l'hôte",
    },
    {
      key: 'warnDays',
      kind: 'number',
      label: 'Préavis avant expiration',
      min: 1,
      max: 180,
      unit: 'jours',
      hint: 'En deçà, la sonde passe en échec — pour alerter avant la panne, pas pendant.',
    },
    {
      key: 'timeoutMs',
      kind: 'number',
      label: "Délai d'expiration",
      min: 1_000,
      max: 30_000,
      step: 500,
      unit: 'ms',
      advanced: true,
    },
  ],
  metrics: [
    { key: 'daysRemaining', label: 'Jours restants', kind: 'days', primary: true },
    { key: 'validTo', label: 'Expire le', kind: 'text', primary: true },
    { key: 'issuer', label: 'Émetteur', kind: 'text' },
    { key: 'subject', label: 'Sujet', kind: 'text' },
    { key: 'protocol', label: 'Protocole', kind: 'text' },
    { key: 'handshakeMs', label: 'Poignée de main', kind: 'duration-ms' },
  ],
  // Une heure : un certificat ne change pas plus vite, et chaque mesure est une
  // poignée de main TLS complète chez quelqu'un d'autre.
  minIntervalSeconds: 3_600,
  defaultIntervalSeconds: 6 * 3_600,
  defaults: { host: '', port: 443, servername: null, warnDays: 21, timeoutMs: 10_000 },
  describeTarget: (config) => (config.port === 443 ? config.host : `${config.host}:${config.port}`),
  linkFor: (config) =>
    config.host === ''
      ? null
      : `https://${config.host}${config.port === 443 ? '' : `:${config.port}`}/`,
  uptimeMeans: 'part du temps où le certificat était valide et hors préavis',
};

// ─── registre ─────────────────────────────────────────────────────────────────

/**
 * Une entrée par type. Le catalogue est typé de façon opaque côté consommateur :
 * personne d'autre que l'implémentation n'a besoin du type exact de la config,
 * et c'est précisément ce qui permet à l'écran de ne connaître aucun type.
 */
export const MONITOR_TYPES: Record<MonitorType, MonitorTypeDefinition<never>> = {
  http: httpDefinition as unknown as MonitorTypeDefinition<never>,
  tls: tlsDefinition as unknown as MonitorTypeDefinition<never>,
};

export type AnyMonitorTypeDefinition = {
  type: MonitorType;
  label: string;
  description: string;
  neverDoes: string;
  schema: z.ZodType<unknown>;
  fields: readonly ConfigField[];
  metrics: readonly MetricDescriptor[];
  minIntervalSeconds: number;
  defaultIntervalSeconds: number;
  defaults: unknown;
  describeTarget: (config: never) => string;
  linkFor: (config: never) => string | null;
  uptimeMeans: string;
};

export function monitorTypeDefinition(type: MonitorType): AnyMonitorTypeDefinition {
  return MONITOR_TYPES[type] as unknown as AnyMonitorTypeDefinition;
}

/** Valide la configuration d'une sonde contre le schéma de **son** type. */
export function parseMonitorConfig(type: MonitorType, config: unknown): unknown {
  return monitorTypeDefinition(type).schema.parse(config);
}

export function safeParseMonitorConfig(
  type: MonitorType,
  config: unknown,
): { ok: true; config: unknown } | { ok: false; error: z.ZodError } {
  const parsed = monitorTypeDefinition(type).schema.safeParse(config);
  return parsed.success ? { ok: true, config: parsed.data } : { ok: false, error: parsed.error };
}

/** La cible d'une sonde, en une ligne. Jamais un `switch` chez l'appelant. */
export function describeMonitorTarget(type: MonitorType, config: unknown): string {
  const definition = monitorTypeDefinition(type);
  const parsed = definition.schema.safeParse(config);
  if (!parsed.success) return '(configuration illisible)';
  return definition.describeTarget(parsed.data as never);
}

export function monitorTargetLink(type: MonitorType, config: unknown): string | null {
  const definition = monitorTypeDefinition(type);
  const parsed = definition.schema.safeParse(config);
  if (!parsed.success) return null;
  return definition.linkFor(parsed.data as never);
}

export function isMonitorType(value: string): value is MonitorType {
  return (MONITOR_TYPES_LIST as readonly string[]).includes(value);
}

/** Bornes absolues de cadence, tous types confondus — ce que la base accepte. */
export const MONITOR_INTERVAL_FLOOR_SECONDS = 30;
export const MONITOR_INTERVAL_CEILING_SECONDS = 30 * 86_400;
