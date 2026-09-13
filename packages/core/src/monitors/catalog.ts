import { z } from 'zod';
import {
  DNS_RECORD_TYPES_LIST,
  DNS_RECORD_TYPE_FORMATS,
  DNS_RECORD_TYPE_LABELS,
  dnsMatchModeSchema,
  dnsRecordTypeSchema,
  parseExpectedRecords,
  validateDnsRecordValue,
  type DnsMatchMode,
  type DnsRecordType,
} from './dns-records.js';
import {
  checkAddress,
  checkNeverAllowable,
  classifyAddress,
  monitorHostSchema,
  monitorUrlSchema,
  type Cidr,
} from './ssrf.js';

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

export const MONITOR_TYPES_LIST = ['http', 'tls', 'tcp', 'dns'] as const;
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

/**
 * `url` et `host` ne sont pas des habillages de saisie : ils **déclarent que le
 * worker ouvrira une socket vers cette valeur**. C'est ce marquage, et lui seul,
 * qui déclenche le contrôle d'adresse SSRF (`checkMonitorTargetLiterals`), sans
 * que personne n'ait à tenir une liste de « quels champs sont des cibles ».
 *
 * Corollaire, et il compte pour la sonde DNS : le nom qu'on **interroge** n'est
 * pas une cible de connexion — on ne s'y connecte jamais, on pose une question à
 * son sujet. Il se déclare donc en `text`, et c'est le **résolveur** qui porte
 * le `host`, parce que c'est lui, et lui seul, qu'on joint par le réseau.
 */
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

// ─── tcp ──────────────────────────────────────────────────────────────────────

export const tcpConfigSchema = z.object({
  host: monitorHostSchema,
  // Pas de port « par défaut » raisonnable au sens strict : on met 22 parce
  // que c'est le port qu'on veut surveiller le plus souvent sans HTTP devant,
  // et parce que c'est aussi celui qui illustre la bannière.
  port: z.number().int().min(1).max(65_535).default(22),
  /**
   * Bannière attendue, cherchée sans égard à la casse dans les premiers octets
   * que le service envoie **de lui-même**. C'est ce qui sépare « quelque chose
   * écoute » de « le bon service écoute ».
   */
  expectBanner: z.string().trim().min(1).max(200).nullable().default(null),
  timeoutMs: z.number().int().min(1_000).max(30_000).default(10_000),
});

export type TcpConfig = z.infer<typeof tcpConfigSchema>;

const tcpDefinition: MonitorTypeDefinition<TcpConfig> = {
  type: 'tcp',
  label: 'Port TCP',
  /**
   * ── Qu'est-ce que « répondre » ? ──────────────────────────────────────────
   * La poignée TCP suffit à établir un fait, et un seul : quelque chose accepte
   * les connexions sur ce port. C'est déjà l'essentiel — un `ECONNREFUSED` sur
   * le 5432 d'une base, c'est le service arrêté ou le pare-feu refermé, et on
   * veut le savoir. Mais ce n'est **que** ça : un processus qui a gardé la
   * socket ouverte en étant incapable de servir accepte encore la poignée. La
   * poignée prouve l'écoute, pas la santé.
   *
   * D'où la bannière, en option. SMTP, SSH, FTP, IMAP, POP3 et Redis avec
   * `MOTD` parlent **les premiers** : ils annoncent qui ils sont avant qu'on
   * ouvre la bouche. Attendre `SSH-2.0` ou `220 ` fait donc passer la sonde de
   * « un port est ouvert » à « le bon service, vivant, écoute derrière ». C'est
   * une preuve qualitativement différente, et elle ne coûte qu'une lecture.
   *
   * ── Ce qu'on ne fait pas, et c'est un choix ───────────────────────────────
   * On **n'envoie jamais rien**. Pas de `EHLO`, pas de `PING`, pas même un
   * retour à la ligne. Deux raisons : une sonde est un constat, pas une action
   * — envoyer des octets à un service inconnu toutes les minutes, c'est le
   * solliciter, parfois le polluer (un `GET / HTTP/1.0` finit dans les journaux
   * d'accès, une commande SMTP dans les compteurs anti-abus) ; et un protocole
   * où le client parle d'abord (PostgreSQL, MySQL, HTTP) demanderait de savoir
   * *quel* protocole, ce qui ferait de cette sonde un client universel. Pour
   * ces services-là, la poignée nue est la bonne réponse, et le mot-clé HTTP
   * ou la sonde TLS font le reste quand on veut plus.
   *
   * Conséquence assumée : attendre une bannière d'un service qui n'en émet pas
   * coûte le délai d'expiration entier, à chaque mesure. Le message le dit.
   */
  description:
    "Une connexion TCP depuis le worker vers un hôte et un port : le port accepte-t-il " +
    'la connexion, en combien de temps, et — si on le demande — le service ' +
    'annonce-t-il bien la bannière attendue.',
  neverDoes:
    "N'envoie aucun octet à la cible et ne parle aucun protocole : elle écoute, elle " +
    'ne sollicite pas. Un service où le client parle en premier ne rendra donc jamais ' +
    'de bannière.',
  schema: tcpConfigSchema,
  fields: [
    { key: 'host', kind: 'host', label: 'Hôte', placeholder: 'exemple.fr' },
    { key: 'port', kind: 'number', label: 'Port', min: 1, max: 65_535 },
    {
      key: 'expectBanner',
      kind: 'text',
      label: 'Bannière attendue',
      optional: true,
      placeholder: 'facultatif — par exemple SSH-2.0',
      hint:
        "Cherchée sans égard à la casse dans les premiers octets que le service envoie " +
        "de lui-même. Vide : la poignée TCP suffit. Renseignée face à un service qui " +
        "n'annonce rien (PostgreSQL, MySQL, HTTP), la sonde attendra le délai entier.",
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
    { key: 'connectMs', label: 'Établissement', kind: 'duration-ms', primary: true },
    { key: 'address', label: 'Adresse jointe', kind: 'text', primary: true },
    { key: 'banner', label: 'Bannière reçue', kind: 'text' },
    { key: 'bannerMs', label: 'Attente de la bannière', kind: 'duration-ms' },
  ],
  // Trente secondes, comme HTTP : une poignée TCP coûte moins qu'une requête
  // HTTP, et ce qu'elle observe — un service tombé — change aussi vite.
  minIntervalSeconds: 30,
  defaultIntervalSeconds: 60,
  defaults: { host: '', port: 22, expectBanner: null, timeoutMs: 10_000 },
  describeTarget: (config) => `${config.host}:${config.port}`,
  /**
   * `null`, et c'est délibéré : `https://hôte:25/` serait un lien cliquable qui
   * mène nulle part. Un port brut n'a pas d'URL, et en inventer une pour
   * remplir la case serait mentir à l'écran.
   */
  linkFor: () => null,
  uptimeMeans: "part du temps où le port a accepté la connexion",
};

// ─── dns ──────────────────────────────────────────────────────────────────────

/**
 * Un résolveur se déclare par son **adresse**, jamais par son nom : un nom
 * demanderait une résolution pour résoudre, et il faudrait bien la faire par
 * quelque chose.
 */
const dnsResolverSchema = z
  .string()
  .trim()
  .min(1)
  .max(45)
  .superRefine((value, ctx) => {
    if (classifyAddress(value) === null) {
      ctx.addIssue({
        code: 'custom',
        message: `« ${value} » n'est pas une adresse IP — un résolveur se déclare par son adresse`,
      });
      return;
    }
    // Le contrôle complet (liste d'autorisation) a lieu côté serveur : ici on
    // ne peut refuser que ce qu'aucune liste ne débloque.
    const verdict = checkNeverAllowable(value);
    if (!verdict.allowed) {
      ctx.addIssue({ code: 'custom', message: verdict.reason ?? 'résolveur refusé' });
    }
  })
  .nullable()
  .default(null);

export const dnsConfigSchema = z
  .object({
    /**
     * Le nom interrogé. `kind: 'text'` et non `'host'` : on ne s'y **connecte**
     * pas, on pose une question à son sujet. Il passe quand même par
     * `monitorHostSchema` pour sa forme.
     */
    name: monitorHostSchema,
    recordType: dnsRecordTypeSchema.default('A'),
    /**
     * Les valeurs attendues, une par ligne (ou séparées par des virgules, sauf
     * pour TXT dont la donnée peut en contenir). **Vide = contrôle de présence** :
     * la sonde vérifie seulement que le nom rend au moins un enregistrement de
     * ce type.
     */
    expected: z.string().trim().max(4_096).default(''),
    match: dnsMatchModeSchema.default('exact'),
    resolver: dnsResolverSchema,
    timeoutMs: z.number().int().min(1_000).max(15_000).default(5_000),
  })
  .superRefine((config, ctx) => {
    // Une valeur attendue mal écrite est une fausse alerte garantie, tous les
    // quarts d'heure, jusqu'à ce que quelqu'un s'en aperçoive. On la refuse à
    // la saisie, avec le format en clair.
    for (const value of parseExpectedRecords(config.recordType, config.expected)) {
      const problem = validateDnsRecordValue(config.recordType, value);
      if (problem) {
        ctx.addIssue({ code: 'custom', path: ['expected'], message: problem });
        return;
      }
    }
  });

export type DnsConfig = z.infer<typeof dnsConfigSchema>;

const dnsDefinition: MonitorTypeDefinition<DnsConfig> = {
  type: 'dns',
  label: 'Enregistrements DNS',
  /**
   * ── Comparer à quoi ? ─────────────────────────────────────────────────────
   * Deux régimes existent dans les services du marché, et ils ne servent pas la
   * même chose : *l'attendu déclaré* (« le A doit valoir 203.0.113.7 ») attrape
   * une erreur de configuration ; *la détection de changement* (« alerte si ça
   * bouge ») attrape un détournement.
   *
   * Ce type n'en implémente qu'**un**, l'attendu déclaré — et rend le second
   * gratuitement, ce qui évite de doubler la complexité. Comparer un ensemble
   * observé à un ensemble déclaré alerte sur toute suppression *et* sur tout
   * ajout : c'est déjà de la détection de changement, avec une référence
   * explicite.
   *
   * ── « Qui valide la nouvelle valeur ? », et pourquoi la réponse est bonne ──
   * Une référence apprise automatiquement — « je mémorise ce que je vois au
   * premier passage, j'alerte ensuite » — pose la question de la réadoption :
   * après une alerte, il faut bien qu'une nouvelle valeur devienne la référence.
   * Si le panel réadopte tout seul, il finit par **apprendre le détournement** —
   * la sonde crie une fois puis se tait, ce qui est exactement le contraire du
   * service rendu. Si l'humain réadopte, il le fait par un bouton… qui écrit la
   * nouvelle valeur quelque part.
   *
   * Ce « quelque part », ici, c'est le champ « valeurs attendues » lui-même. Un
   * humain modifie la sonde, ce qui passe par la même route, la même validation
   * et le même journal d'audit que tout le reste. Il n'y a donc pas de second
   * mécanisme de référence à écrire, pas de colonne à ajouter, et surtout pas de
   * réadoption silencieuse.
   *
   * Ce choix a aussi une raison de structure : l'abstraction `MonitorProbe` est
   * `run(config, ctx) → CheckResult`. Une sonde **ne peut rien écrire**. Une
   * référence apprise demanderait de rendre les sondes capables d'écrire dans
   * leur propre configuration — c'est-à-dire de percer l'abstraction pour un
   * seul type. Ça ne valait pas le prix.
   *
   * ── Quel résolveur ? ──────────────────────────────────────────────────────
   * Par défaut, celui du système — celui du conteneur worker. Il ne mesure pas
   * « ce que le monde voit » : il mesure ce que voit une machine du parc, avec
   * son cache, ses éventuelles vues internes (split-horizon) et son suffixe de
   * recherche. C'est un défaut assumé, pour deux raisons : c'est le chemin de
   * résolution qui compte réellement pour les machines qu'on exploite, et il
   * n'ajoute aucune dépendance envers un tiers.
   *
   * Déclarer un résolveur public (`1.1.1.1`, `9.9.9.9`) bascule la sonde vers
   * l'autre question — « qu'est-ce que le monde voit ? » — qui est la bonne pour
   * détecter un détournement, et qui contourne le cache local. C'est un champ,
   * pas un type à part, parce que c'est la même mesure vue d'un autre point.
   */
  description:
    "Une interrogation DNS depuis le worker : les enregistrements du type demandé " +
    'existent-ils, et valent-ils ce qu\'on a déclaré. La comparaison ignore l\'ordre ' +
    'et la casse des noms — un résolveur permute ses réponses, ce n\'est pas un incident.',
  neverDoes:
    "Ne modifie aucune zone et n'interroge pas le registre du domaine : elle lit des " +
    "enregistrements, elle ne dit rien de l'expiration du nom.",
  schema: dnsConfigSchema as unknown as z.ZodType<DnsConfig>,
  fields: [
    { key: 'name', kind: 'text', label: 'Nom interrogé', placeholder: 'exemple.fr' },
    {
      key: 'recordType',
      kind: 'select',
      label: "Type d'enregistrement",
      options: DNS_RECORD_TYPES_LIST.map((record) => ({
        value: record,
        label: DNS_RECORD_TYPE_LABELS[record],
      })),
    },
    {
      key: 'expected',
      kind: 'text',
      label: 'Valeurs attendues',
      optional: true,
      placeholder: 'laisser vide pour ne vérifier que la présence',
      hint:
        'Séparées par des virgules ou des retours à la ligne (retours à la ligne ' +
        "seulement pour TXT, dont la valeur peut contenir une virgule). Formats : A " +
        `« ${DNS_RECORD_TYPE_FORMATS.A} », MX « ${DNS_RECORD_TYPE_FORMATS.MX} », ` +
        `CAA « ${DNS_RECORD_TYPE_FORMATS.CAA} », SRV « ${DNS_RECORD_TYPE_FORMATS.SRV} ».`,
    },
    {
      key: 'match',
      kind: 'select',
      label: 'Comparaison',
      options: [
        { value: 'exact', label: 'Exactement ces valeurs — un ajout est une anomalie' },
        { value: 'contains', label: 'Au moins ces valeurs — le reste est toléré' },
      ] satisfies ReadonlyArray<{ value: DnsMatchMode; label: string }>,
      hint:
        "« Exactement » détecte l'enregistrement ajouté, la signature d'un détournement. " +
        '« Au moins » sert pour TXT, où un domaine porte de front un SPF, un DKIM et ' +
        'des preuves de propriété dont on ne veut pas tenir l\'inventaire.',
    },
    {
      key: 'resolver',
      kind: 'host',
      label: 'Résolveur',
      optional: true,
      advanced: true,
      placeholder: 'celui du système',
      hint:
        "Une adresse IP. Vide : le résolveur du conteneur worker — ce que voit une " +
        'machine du parc. Un résolveur public (1.1.1.1, 9.9.9.9) mesure plutôt ce que ' +
        'voit le monde, et contourne le cache local.',
    },
    {
      key: 'timeoutMs',
      kind: 'number',
      label: "Délai d'expiration",
      min: 1_000,
      max: 15_000,
      step: 500,
      unit: 'ms',
      advanced: true,
    },
  ],
  metrics: [
    { key: 'resolveMs', label: 'Temps de résolution', kind: 'duration-ms', primary: true },
    { key: 'recordCount', label: 'Enregistrements', kind: 'number', primary: true },
    { key: 'values', label: 'Valeurs observées', kind: 'text' },
    { key: 'missing', label: 'Attendues et absentes', kind: 'text' },
    { key: 'unexpected', label: 'Observées en trop', kind: 'text' },
    { key: 'resolver', label: 'Résolveur interrogé', kind: 'text' },
    { key: 'minTtl', label: 'TTL le plus court', kind: 'number' },
  ],
  /**
   * Cinq minutes au minimum, un quart d'heure par défaut.
   *
   * Deux bornes se rencontrent ici. Par le bas : 300 s est le TTL le plus court
   * qu'on configure couramment, et en deçà du TTL la réponse sort du cache du
   * résolveur — on paie une interrogation pour réapprendre ce qu'on savait déjà.
   * Interroger plus vite que le TTL, c'est mesurer son propre cache.
   *
   * Par le bas aussi, mais pour une autre raison : un résolveur public est une
   * ressource **partagée et gratuite**. Une requête HTTP vers son propre site,
   * on se la doit à soi-même ; une requête à `1.1.1.1` toutes les minutes, c'est
   * quelqu'un d'autre qui la paie. Cinquante sondes DNS à la minute feraient de
   * ce panel un nuisible pour un gain nul.
   *
   * Par le haut : un détournement de NS doit se voir dans l'heure, pas dans la
   * journée. Un quart d'heure par défaut tient les deux.
   */
  minIntervalSeconds: 300,
  defaultIntervalSeconds: 900,
  defaults: {
    name: '',
    recordType: 'A' as DnsRecordType,
    expected: '',
    match: 'exact' as DnsMatchMode,
    resolver: null,
    timeoutMs: 5_000,
  },
  describeTarget: (config) => `${config.recordType} ${config.name}`,
  /** Aucun lien : un enregistrement DNS n'est pas une page. */
  linkFor: () => null,
  uptimeMeans: "part du temps où les enregistrements étaient ceux qu'on attend",
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
  tcp: tcpDefinition as unknown as MonitorTypeDefinition<never>,
  dns: dnsDefinition as unknown as MonitorTypeDefinition<never>,
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

// ─── contrôle SSRF à la création, sans switch et sans réseau ──────────────────

export type MonitorTargetVerdict =
  | { allowed: true }
  | { allowed: false; field: string; reason: string };

/**
 * Refuse, **au moment d'enregistrer la sonde**, toute cible écrite en adresse
 * littérale interdite.
 *
 * Pourquoi ici et pas dans chaque schéma : le catalogue sait déjà quels champs
 * sont des endpoints, puisqu'il les déclare en `kind: 'host'` ou `kind: 'url'`
 * pour que l'écran les affiche. On réutilise ce marquage plutôt que d'ajouter
 * une liste parallèle à tenir à jour — un type qui arrive plus tard est couvert
 * dès qu'il déclare ses champs, sans rien ajouter ici. Il n'y a donc aucun
 * `if (type === …)`.
 *
 * Pourquoi pas dans le schéma Zod du type : la liste d'autorisation vient de
 * `MONITOR_ALLOWED_CIDRS`, donc de l'environnement du serveur. Le catalogue est
 * importé par des composants client, où cet environnement n'existe pas — un
 * schéma qui le lirait refuserait dans le navigateur une plage que le serveur
 * accepte. Le schéma s'en tient donc à ce qui est vrai partout (les catégories
 * qu'aucune liste ne débloque, via `checkHostname`) et l'appelant serveur
 * complète par cette fonction.
 *
 * Ce qu'elle **ne** fait **pas** : résoudre. Un nom n'est jugé qu'au moment de
 * sonder, par `resolveGuarded()`, qui contrôle toutes ses adresses. Une
 * validation ne fait pas de requête réseau, et de toute façon le contrôle qui
 * compte est celui d'avant la connexion — la fenêtre de rebinding se ferme là,
 * pas ici.
 */
export function checkMonitorTargetLiterals(
  type: MonitorType,
  config: unknown,
  allowlist: readonly Cidr[],
): MonitorTargetVerdict {
  const definition = monitorTypeDefinition(type);
  const parsed = definition.schema.safeParse(config);
  // Une configuration illisible est refusée par ailleurs, avec un meilleur
  // message ; ce n'est pas à la garde de le dire.
  if (!parsed.success) return { allowed: true };
  const record = parsed.data as Record<string, unknown>;

  for (const field of definition.fields) {
    if (field.kind !== 'host' && field.kind !== 'url') continue;
    const raw = record[field.key];
    if (typeof raw !== 'string' || raw.trim() === '') continue;

    let host = raw.trim();
    if (field.kind === 'url') {
      try {
        host = new URL(host).hostname;
      } catch {
        continue;
      }
    }
    host = host.replace(/^\[|\]$/g, '');

    // Un nom : rien à dire ici, tout se joue à la résolution.
    if (classifyAddress(host) === null) continue;

    const verdict = checkAddress(host, allowlist);
    if (!verdict.allowed) {
      return { allowed: false, field: field.key, reason: verdict.reason };
    }
  }

  return { allowed: true };
}

/** Bornes absolues de cadence, tous types confondus — ce que la base accepte. */
export const MONITOR_INTERVAL_FLOOR_SECONDS = 30;
export const MONITOR_INTERVAL_CEILING_SECONDS = 30 * 86_400;
