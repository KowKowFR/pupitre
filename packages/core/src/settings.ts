import { TWO_FACTOR_POLICIES, type Permission } from './permissions.js';
import {
  SCANNER_KEYS,
  failOnSchema,
  scannerKeySchema,
  type ScanConfig,
  type ScannerKey,
} from './scan.js';
import {
  AI_MODEL_TIER_LABELS,
  AI_PROVIDERS,
  aiModelHint,
  aiModelHints,
  aiModelMismatch,
  aiModelOptions,
  aiProviderDescriptor,
  aiProviderDescriptors,
  defaultAiModel,
  isAiProvider,
  type AiModelOption,
  type AiProvider,
  type AiProviderDescriptor,
} from './ai/catalog.js';
import { z } from 'zod';

/**
 * Paramètres d'instance — schéma unique de vérité.
 *
 * Stockés en base dans **une seule colonne JSONB**, pas une colonne par
 * réglage : ajouter un paramètre ne doit pas coûter une migration. Le prix à
 * payer, c'est que la base ne garantit plus la forme du contenu — d'où ce
 * schéma, appliqué à chaque lecture, qui comble les champs absents par leur
 * défaut. Une base vierge, un JSON tronqué ou un champ ajouté après coup
 * rendent donc toujours un objet complet et valide.
 *
 * Ce module ne dépend que de Zod : il est importé par `@pupitre/db`, par le panel
 * et par le worker. La clé d'API de l'IA n'y figure volontairement pas — un
 * secret ne voyage pas avec de la configuration ordinaire, il vit dans sa
 * propre colonne chiffrée (cf. `app_settings.ai_api_key_encrypted`).
 */

/**
 * Modèle par défaut de l'instance neuve — celui d'OpenRouter, le fournisseur
 * par défaut. Chaque fournisseur a le sien : `defaultAiModel(provider)` est la
 * fonction à appeler dès qu'on sait de quel fournisseur on parle.
 *
 * Le catalogue vit sous `ai/catalog.ts` mais ne dépend de rien : la racine de
 * `@pupitre/core` — donc `@pupitre/db` et le worker — peut donc connaître la liste des
 * fournisseurs et leurs défauts sans tirer le SDK IA dans son graphe.
 */
export const DEFAULT_AI_MODEL = defaultAiModel('openrouter');

/** Locales proposées. Liste explicite : chacune doit avoir été relue en vrai. */
export const SUPPORTED_LOCALES = ['fr-FR', 'en-GB', 'en-US', 'de-DE', 'es-ES'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/**
 * Les locales que le sélecteur propose — celles dont le panel sait réellement
 * parler la langue.
 *
 * `SUPPORTED_LOCALES` reste plus large, et volontairement : une instance qui
 * porte déjà `de-DE` en base continue de se lire sans que sa validation
 * échoue au démarrage. Elle obtient simplement l'interface en anglais
 * (cf. `languageOf()`) et ne retrouvera plus « Deutsch » dans la liste. Offrir
 * un choix qui ne change qu'à moitié l'écran serait pire que ne pas l'offrir.
 *
 * Ajouter une langue, c'est écrire son dictionnaire, l'ajouter à
 * `UI_LANGUAGES`, puis ajouter sa locale ici. Dans cet ordre.
 */
export const TRANSLATED_LOCALES = ['fr-FR', 'en-GB', 'en-US'] as const;

/**
 * Comment chaque locale se nomme **dans sa propre langue**. Un anglophone
 * arrivé sur une instance en français doit reconnaître sa ligne sans savoir
 * lire les autres — c'est la seule chaîne du panel qui ne se traduit pas.
 */
export const LOCALE_LABELS: Readonly<Record<SupportedLocale, string>> = {
  'fr-FR': 'Français (France)',
  'en-GB': 'English (United Kingdom)',
  'en-US': 'English (United States)',
  'de-DE': 'Deutsch (Deutschland)',
  'es-ES': 'Español (España)',
};

export const DATE_STYLES = ['short', 'medium', 'long'] as const;
export type DateStyleName = (typeof DATE_STYLES)[number];

export {
  AI_MODEL_TIER_LABELS,
  AI_PROVIDERS,
  aiModelHint,
  aiModelHints,
  aiModelMismatch,
  aiModelOptions,
  aiProviderDescriptor,
  aiProviderDescriptors,
  defaultAiModel,
  isAiProvider,
  type AiModelOption,
  type AiProvider,
  type AiProviderDescriptor,
};

export const DEFAULT_TIMEZONE = 'Europe/Paris';

/**
 * Un fuseau invalide en base ferait planter chaque rendu de page : on refuse
 * à l'entrée plutôt que de le découvrir à l'affichage. `Intl` est le seul juge
 * fiable — la liste des fuseaux dépend de la version d'ICU embarquée, pas d'une
 * énumération qu'on figerait dans le code.
 */
export function isValidTimeZone(value: string): boolean {
  if (value.trim().length === 0) return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Fuseaux connus de ce runtime, pour alimenter une liste déroulante. */
export function supportedTimeZones(): string[] {
  try {
    return [...Intl.supportedValuesOf('timeZone')];
  } catch {
    // Runtime sans ICU complet : on rend au moins de quoi choisir.
    return [DEFAULT_TIMEZONE, 'UTC'];
  }
}

const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(isValidTimeZone, { message: 'Fuseau horaire IANA inconnu' });

/**
 * Champs de la section IA, **sans défaut** — même précaution que pour les
 * champs racine plus bas, et pour la même raison : `schema.default(x).optional()`
 * rend `x` quand la clé est absente. Un `PATCH { ai: { enabled: false } }`
 * repartait donc avec un objet `ai` complet de valeurs par défaut, et
 * réinitialisait silencieusement le fournisseur, le modèle et la température de
 * l'instance. Le défaut n'est appliqué que sur le schéma de *lecture*.
 */
const aiFields = {
  /** Liste dérivée du catalogue : un fournisseur ajouté y apparaît sans rien toucher ici. */
  provider: z.enum(AI_PROVIDERS),
  /**
   * Identifiant de modèle, dans la convention du fournisseur choisi. Le défaut
   * ne peut pas dépendre du fournisseur dans un schéma d'objet plat : c'est
   * `resolveAiConfig()` qui retombe sur `defaultAiModel(provider)` quand le
   * champ est vide, et `aiModelMismatch()` qui signale un identifiant qui
   * appartient visiblement à un autre fournisseur.
   */
  model: z.string().trim().min(1).max(120),
  /**
   * URL d'une API compatible OpenAI auto-hébergée. Validée comme une URL —
   * une valeur bancale ici ferait échouer chaque génération sans rien dire.
   * Ignorée par les fournisseurs qui ne la déclarent pas (`supportsBaseUrl`).
   */
  baseUrl: z.union([z.literal(''), z.string().trim().url().max(300)]),
  enabled: z.boolean(),
  temperature: z.number().min(0).max(1),
  maxTokens: z.number().int().min(256).max(200_000),
};

export const aiSettingsSchema = z.object({
  provider: aiFields.provider.default('openrouter'),
  model: aiFields.model.default(DEFAULT_AI_MODEL),
  baseUrl: aiFields.baseUrl.default(''),
  enabled: aiFields.enabled.default(true),
  temperature: aiFields.temperature.default(0.2),
  maxTokens: aiFields.maxTokens.default(8_192),
});

/** Patch partiel de la section IA : une clé absente reste absente. */
export const aiSettingsPatchSchema = z.object({
  provider: aiFields.provider.optional(),
  model: aiFields.model.optional(),
  baseUrl: aiFields.baseUrl.optional(),
  enabled: aiFields.enabled.optional(),
  temperature: aiFields.temperature.optional(),
  maxTokens: aiFields.maxTokens.optional(),
});

export type AiSettings = z.infer<typeof aiSettingsSchema>;

export const DEFAULT_AI_SETTINGS: AiSettings = {
  provider: 'openrouter',
  model: DEFAULT_AI_MODEL,
  baseUrl: '',
  enabled: true,
  temperature: 0.2,
  maxTokens: 8_192,
};

/**
 * Champs de la section sécurité, **sans défaut** — la forme de référence.
 *
 * Même séparation que pour l'IA et pour la racine des paramètres, et pour la
 * même raison : `schema.partial()` sur des champs porteurs de `.default()`
 * **remplit quand même** ces défauts pour les clés absentes. Un PATCH ne
 * parlant que de `scanningEnabled` réinitialisait donc silencieusement les
 * scanners écartés et le seuil de blocage — une politique de sécurité
 * détricotée par un geste qui ne la visait pas.
 */
const securityFields = {
  /**
   * Interrupteur général. À `false`, plus aucun scan ne sera lancé, sur aucun
   * déploiement, tant que le réglage n'est pas remis à `true`.
   */
  scanningEnabled: z.boolean(),
  /**
   * Scanners écartés un par un, même quand l'analyse reste active. Permet de
   * couper Trivy sans renoncer à Grype, par exemple parce qu'un seul des deux
   * peut atteindre sa base de vulnérabilités depuis la machine cible.
   */
  disabledScanners: z.array(scannerKeySchema).max(SCANNER_KEYS.length),
  /**
   * Sévérité à partir de laquelle un finding bloque la mise en ligne.
   *
   * Vit ici depuis que l'écran de déploiement ne le demande plus : une
   * politique de sécurité qui se choisit au coup par coup, déploiement par
   * déploiement, n'est pas une politique.
   *
   * Le défaut est `NONE` — on analyse et on rapporte, on ne bloque pas.
   * Bloquer d'emblée paraît plus sûr et ne l'est pas : `nginx:1.29-alpine`
   * porte 26 findings CRITICAL, `httpd:2.4-alpine` en porte 40. Un seuil
   * bloquant par défaut refuse donc toute image publique dès la première mise
   * en ligne, et l'opérateur coupe l'analyse entière pour avancer — il se
   * retrouve sans scan du tout. Informer par défaut, bloquer sur décision.
   */
  failOn: failOnSchema,
  /**
   * Ne bloquer que sur les failles **corrigeables**. C'est ce qui rend un seuil
   * tenable sur des images publiques : la plupart de leurs CRITICAL n'ont pas
   * de correctif, et rien ne sert de bloquer sur ce qu'aucune mise à jour ne
   * règle. Une application peut en décider autrement.
   */
  onlyFixable: z.boolean(),
};

/** Lecture : les défauts comblent ce qu'une base ancienne ne porte pas. */
export const securitySettingsSchema = z.object({
  scanningEnabled: securityFields.scanningEnabled.default(true),
  disabledScanners: securityFields.disabledScanners.default([]),
  failOn: securityFields.failOn.default('NONE'),
  onlyFixable: securityFields.onlyFixable.default(false),
});

/** Patch partiel : une clé absente reste absente. */
export const securitySettingsPatchSchema = z.object({
  scanningEnabled: securityFields.scanningEnabled.optional(),
  disabledScanners: securityFields.disabledScanners.optional(),
  failOn: securityFields.failOn.optional(),
  onlyFixable: securityFields.onlyFixable.optional(),
});

export type SecuritySettings = z.infer<typeof securitySettingsSchema>;

export const DEFAULT_SECURITY_SETTINGS: SecuritySettings = {
  scanningEnabled: true,
  disabledScanners: [],
  failOn: 'NONE',
  onlyFixable: false,
};

/**
 * Connexion unique par OpenID Connect — Keycloak, Authentik, Google, Entra :
 * tout fournisseur qui publie un document de découverte.
 *
 * Le secret du client n'est **pas** ici : comme la clé d'IA, il a sa colonne
 * chiffrée (`app_settings.sso_client_secret_encrypted`). Ce qui est ici peut
 * être lu, rendu par l'API et écrit au journal sans rien exposer.
 *
 * Mêmes champs sans défaut que les autres sections, pour la même raison : un
 * PATCH qui ne parle que de `enabled` ne doit pas effacer les correspondances
 * de rôles.
 */
const ssoFields = {
  enabled: z.boolean(),
  /** Le texte du bouton : « Se connecter avec Keycloak ». */
  label: z.string().trim().min(1).max(40),
  /**
   * L'émetteur, tel que le fournisseur l'annonce : pour Keycloak,
   * `https://auth.exemple.fr/realms/mon-realm`. La découverte est lue à
   * `{issuer}/.well-known/openid-configuration`.
   */
  issuer: z.union([
    z.literal(''),
    z
      .string()
      .trim()
      .max(300)
      .url()
      .refine((value) => /^https?:\/\//.test(value), { message: 'adresse http(s) attendue' }),
  ]),
  clientId: z.string().trim().max(200),
  /** Les portées demandées, séparées par des espaces. `openid` est toujours ajoutée. */
  scopes: z.string().trim().max(300),
  /** Créer le compte à la première connexion. Sinon, seuls les comptes existants entrent. */
  autoCreate: z.boolean(),
  /**
   * Lier la connexion à un compte existant de même e-mail — seulement quand le
   * fournisseur déclare cet e-mail vérifié.
   */
  linkByEmail: z.boolean(),
  /** Où lire les groupes dans le profil : `groups`, ou un chemin `realm_access.roles`. */
  groupsClaim: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[\w:-]+(\.[\w:-]+)*$/, 'chemin de champ attendu, ex. groups ou realm_access.roles'),
  /** Groupe du fournisseur → rôle de Pupitre. La première qui correspond l'emporte. */
  roleMappings: z
    .array(
      z.object({
        group: z.string().trim().min(1).max(200),
        role: z.string().trim().min(1).max(60),
      }),
    )
    .max(50),
  /** Le rôle de qui n'a aucun groupe reconnu. */
  defaultRole: z.string().trim().min(1).max(60),
  /** Réappliquer les correspondances à chaque connexion : le fournisseur fait foi. */
  syncRoles: z.boolean(),
};

export const ssoSettingsSchema = z.object({
  enabled: ssoFields.enabled.default(false),
  label: ssoFields.label.default('Keycloak'),
  issuer: ssoFields.issuer.default(''),
  clientId: ssoFields.clientId.default(''),
  scopes: ssoFields.scopes.default('openid profile email'),
  autoCreate: ssoFields.autoCreate.default(true),
  linkByEmail: ssoFields.linkByEmail.default(true),
  groupsClaim: ssoFields.groupsClaim.default('groups'),
  roleMappings: ssoFields.roleMappings.default([]),
  defaultRole: ssoFields.defaultRole.default('no-access'),
  syncRoles: ssoFields.syncRoles.default(true),
});

export const ssoSettingsPatchSchema = z.object({
  enabled: ssoFields.enabled.optional(),
  label: ssoFields.label.optional(),
  issuer: ssoFields.issuer.optional(),
  clientId: ssoFields.clientId.optional(),
  scopes: ssoFields.scopes.optional(),
  autoCreate: ssoFields.autoCreate.optional(),
  linkByEmail: ssoFields.linkByEmail.optional(),
  groupsClaim: ssoFields.groupsClaim.optional(),
  roleMappings: ssoFields.roleMappings.optional(),
  defaultRole: ssoFields.defaultRole.optional(),
  syncRoles: ssoFields.syncRoles.optional(),
});

export type SsoSettings = z.infer<typeof ssoSettingsSchema>;

export const DEFAULT_SSO_SETTINGS: SsoSettings = ssoSettingsSchema.parse({});

/**
 * Les comptes et leurs sessions : qui doit porter un second facteur, et combien
 * de temps une session reste ouverte.
 *
 * Les durées sont en heures, choisies dans une liste courte : une durée libre
 * invite à des valeurs qu'on ne relit jamais (une session de 9 999 heures).
 */
export const SESSION_IDLE_HOURS = [1, 8, 24, 168, 720] as const;
export const SESSION_MAX_HOURS = [24, 168, 720] as const;

const accountsFields = {
  /**
   * `off` : personne n'y est tenu. `sensitive` : tout rôle qui porte une
   * permission sensible (`SENSITIVE_PERMISSIONS`). `all` : tous les comptes.
   */
  twoFactorPolicy: z.enum(TWO_FACTOR_POLICIES),
  /** Sans activité pendant cette durée, la session se ferme. Toute requête la prolonge. */
  sessionIdleHours: z.union(
    SESSION_IDLE_HOURS.map((hours) => z.literal(hours)) as unknown as [
      z.ZodLiteral<1>,
      z.ZodLiteral<8>,
      z.ZodLiteral<24>,
      z.ZodLiteral<168>,
      z.ZodLiteral<720>,
    ],
  ),
  /** Au-delà, la session se ferme même active : on se reconnecte. `null` : pas de plafond. */
  sessionMaxHours: z
    .union(
      SESSION_MAX_HOURS.map((hours) => z.literal(hours)) as unknown as [
        z.ZodLiteral<24>,
        z.ZodLiteral<168>,
        z.ZodLiteral<720>,
      ],
    )
    .nullable(),
};

export const accountsSettingsSchema = z.object({
  twoFactorPolicy: accountsFields.twoFactorPolicy.default('off'),
  sessionIdleHours: accountsFields.sessionIdleHours.default(168),
  sessionMaxHours: accountsFields.sessionMaxHours.default(null),
});

export const accountsSettingsPatchSchema = z.object({
  twoFactorPolicy: accountsFields.twoFactorPolicy.optional(),
  sessionIdleHours: accountsFields.sessionIdleHours.optional(),
  sessionMaxHours: accountsFields.sessionMaxHours.optional(),
});

export type AccountsSettings = z.infer<typeof accountsSettingsSchema>;

export const DEFAULT_ACCOUNTS_SETTINGS: AccountsSettings = accountsSettingsSchema.parse({});

/**
 * La politique de scan de l'instance, telle qu'elle s'applique à un
 * déploiement qui n'en demande aucune en particulier.
 *
 * C'est le pendant de `applySecuritySettings` : celle-ci oppose un veto à une
 * demande explicite, celle-là fournit la politique quand personne n'en formule.
 * Avant que les paramètres n'existent, l'absence de configuration valait
 * « aucun scan » — défendable quand l'écran de déploiement portait le choix,
 * intenable depuis qu'il ne le porte plus : retirer trois cases à cocher aurait
 * silencieusement désarmé l'analyse de toutes les mises en ligne.
 */
export function scanConfigFromSettings(security: SecuritySettings): ScanConfig {
  if (!security.scanningEnabled) {
    return { scanners: [], failOn: 'NONE', disabledBy: 'settings' };
  }

  const disabled = new Set<ScannerKey>(security.disabledScanners);
  const scanners = SCANNER_KEYS.filter((scanner) => !disabled.has(scanner));
  if (scanners.length === 0) {
    return { scanners: [], failOn: 'NONE', disabledBy: 'settings' };
  }

  return { scanners: [...scanners], failOn: security.failOn, onlyFixable: security.onlyFixable };
}

/**
 * Applique les réglages de sécurité à une configuration de scan demandée.
 *
 * Appelée **au moment de l'enfilement**, pas dans le worker : la configuration
 * est gelée dans le déploiement, et elle doit dire la vérité sur ce qui va
 * tourner. La filtrer plus tard laisserait en base la trace d'un scanner qui
 * n'a jamais été lancé — un mensonge durable, dans la seule colonne qui sert
 * ensuite à comprendre ce qui a été vérifié.
 *
 * Conséquence assumée : rallumer l'analyse ne rétroagit pas sur les
 * déploiements déjà enfilés. C'est la même sémantique de gel que l'AppSpec.
 */
export function applySecuritySettings(
  requested: ScanConfig,
  security: SecuritySettings,
): ScanConfig {
  if (!security.scanningEnabled) {
    // `failOn` retombe à NONE : garder un seuil de blocage sans rien pour
    // l'évaluer donnerait une promesse que personne ne tient.
    return { ...requested, scanners: [], failOn: 'NONE', disabledBy: 'settings' };
  }

  // Une demande qui ne dit rien des corrigeables suit l'instance.
  const withFixable: ScanConfig = {
    ...requested,
    onlyFixable: requested.onlyFixable ?? security.onlyFixable,
  };

  const disabled = new Set<ScannerKey>(security.disabledScanners);
  const kept = requested.scanners.filter((scanner) => !disabled.has(scanner));
  if (kept.length === requested.scanners.length) return withFixable;

  return {
    ...withFixable,
    scanners: kept,
    ...(kept.length === 0 ? { failOn: 'NONE' as const, disabledBy: 'settings' as const } : {}),
  };
}

/* ---------------------------------------------------------------------------
   Assistant de démarrage
   ------------------------------------------------------------------------- */

/**
 * Les étapes, dans l'ordre du parcours. L'ordre n'est pas décoratif : il va du
 * plus général au plus particulier, et chaque étape ne dépend que des
 * précédentes. `welcome` situe le panel avant de rien demander ; `identity`
 * n'engage rien d'extérieur ; `target` est la seule qui touche une machine ;
 * `proxy` la suit : le reverse proxy d'une machine se règle quand elle existe ;
 * `role` puis `user` viennent après elle parce qu'un rôle sert à donner accès
 * à quelque chose qui existe — inviter quelqu'un sur un panel sans cible n'a
 * pas d'objet ; `security` règle ce qui s'appliquera aux déploiements à venir ;
 * `summary` ne fait que rendre compte.
 */
export const ONBOARDING_STEPS = [
  'welcome',
  'identity',
  'target',
  'proxy',
  'role',
  'user',
  'security',
  'summary',
] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number];

/**
 * Quatre états, parce que trois questions distinctes doivent trouver une
 * réponse et qu'un booléen n'en couvre qu'une :
 *
 *   `pending`     — jamais proposé. C'est l'état d'une installation neuve.
 *   `in_progress` — proposé au moins une fois, ni terminé ni abandonné. C'est
 *                   ici que `currentStep` a un sens : on reprend où l'on
 *                   s'était arrêté.
 *   `dismissed`   — abandonné volontairement («&nbsp;je m'en occupe plus
 *                   tard&nbsp;»). Ce n'est pas «&nbsp;terminé&nbsp;» : le
 *                   récapitulatif dira toujours ce qui n'a pas été fait.
 *   `completed`   — parcouru jusqu'au bout.
 *
 * Confondre `dismissed` et `completed` reviendrait à prétendre qu'une
 * installation est configurée alors que personne n'a rien fait ; confondre
 * `pending` et `in_progress` ferait tout recommencer à celui qui ferme son
 * navigateur au milieu.
 */
export const ONBOARDING_STATUSES = ['pending', 'in_progress', 'dismissed', 'completed'] as const;
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];

/**
 * Horodatage ISO. `Date.parse` plutôt qu'un format figé : la valeur vient de
 * `toISOString()`, et l'unique chose à garantir est qu'elle se relise.
 */
const onboardingTimestamp = z
  .string()
  .max(40)
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: 'Horodatage ISO invalide' })
  .nullable()
  .default(null);

const onboardingStepList = z
  .array(z.enum(ONBOARDING_STEPS))
  .max(ONBOARDING_STEPS.length)
  .default([]);

export const onboardingStateSchema = z.object({
  status: z.enum(ONBOARDING_STATUSES).default('pending'),
  /** Où l'on reprend. N'a de sens que tant que le parcours n'est pas soldé. */
  currentStep: z.enum(ONBOARDING_STEPS).default('welcome'),
  /** Étapes accomplies — quelque chose a réellement été créé ou enregistré. */
  completed: onboardingStepList,
  /** Étapes passées sciemment. Distinct de « accomplie », et de « pas encore vue ». */
  skipped: onboardingStepList,
  /** Première fois que l'assistant a été montré à quelqu'un. */
  offeredAt: onboardingTimestamp,
  finishedAt: onboardingTimestamp,
  dismissedAt: onboardingTimestamp,
  /** Nombre de relances depuis les paramètres. Zéro pour le parcours d'origine. */
  runs: z.number().int().min(0).max(10_000).default(0),
});

export type OnboardingState = z.infer<typeof onboardingStateSchema>;

export const DEFAULT_ONBOARDING_STATE: OnboardingState = onboardingStateSchema.parse({});

/**
 * Ce qu'une étape est, une fois la prose retirée.
 *
 * Le titre, le résumé, le détail et le prix à payer pour la passer vivaient
 * ici. Ils sont partis dans `apps/web/src/i18n/messages/onboarding.ts`, sous
 * `step.<id>.*` : c'était de l'affichage, rien dans ce paquet ne les lisait, et
 * les garder aurait obligé le catalogue à porter deux langues par champ. Ce qui
 * reste décide — quelle permission l'étape exige, et si on peut la passer — et
 * ne dépend d'aucune langue.
 */
export type OnboardingStepDefinition = {
  id: OnboardingStepId;
  /**
   * Permission sans laquelle l'étape finirait en 403. `null` pour les étapes
   * qui ne créent rien (`welcome`, `summary`) : elles n'ouvrent aucun droit et
   * ne suffisent jamais, à elles seules, à justifier l'assistant.
   */
  requires: Permission | null;
  /**
   * Facultative : elle peut être passée explicitement. La clé `step.<id>.cost`
   * du dictionnaire dit alors ce qu'on perd, et elle n'existe que pour ces
   * étapes-là — un bouton «&nbsp;Passer&nbsp;» sans conséquence annoncée n'est
   * pas un choix éclairé. `optional` suffit donc à savoir si le prix se lit.
   */
  optional: boolean;
};

export const ONBOARDING_STEP_DEFINITIONS: readonly OnboardingStepDefinition[] = [
  { id: 'welcome', requires: null, optional: false },
  { id: 'identity', requires: 'settings:manage', optional: false },
  { id: 'target', requires: 'target:create', optional: true },
  { id: 'proxy', requires: 'target:update', optional: true },
  { id: 'role', requires: 'role:manage', optional: true },
  { id: 'user', requires: 'user:manage', optional: true },
  { id: 'security', requires: 'settings:manage', optional: true },
  { id: 'summary', requires: null, optional: false },
];

const STEP_BY_ID = new Map<OnboardingStepId, OnboardingStepDefinition>(
  ONBOARDING_STEP_DEFINITIONS.map((step) => [step.id, step]),
);

export function onboardingStep(id: OnboardingStepId): OnboardingStepDefinition {
  const step = STEP_BY_ID.get(id);
  // Impossible par typage ; la garde existe pour le JSON relu depuis la base.
  if (!step) throw new Error(`Étape d'onboarding inconnue : ${id}`);
  return step;
}

/**
 * Étapes retenues pour une personne donnée.
 *
 * Une étape qu'on ne peut pas accomplir n'est pas grisée, elle est **absente** :
 * proposer un formulaire dont l'enregistrement finira en 403 est pire que ne
 * rien proposer du tout. `welcome` et `summary` n'exigent rien et encadrent
 * toujours le parcours — mais seulement s'il reste quelque chose entre les deux.
 */
export function onboardingStepsFor(
  can: (permission: Permission) => boolean,
): OnboardingStepDefinition[] {
  const actionable = ONBOARDING_STEP_DEFINITIONS.filter(
    (step) => step.requires !== null && can(step.requires),
  );
  if (actionable.length === 0) return [];

  return ONBOARDING_STEP_DEFINITIONS.filter(
    (step) => step.requires === null || can(step.requires),
  );
}

/**
 * L'assistant concerne-t-il cette personne ? Faux pour un observateur : il n'y
 * a rien qu'il puisse faire, l'écran ne lui apprendrait qu'à lire des refus.
 */
export function onboardingApplies(can: (permission: Permission) => boolean): boolean {
  return ONBOARDING_STEP_DEFINITIONS.some(
    (step) => step.requires !== null && can(step.requires),
  );
}

/** Soldé : plus rien à reprendre, dans un sens ou dans l'autre. */
export function isOnboardingSettled(state: OnboardingState): boolean {
  return state.status === 'completed' || state.status === 'dismissed';
}

/** Ce qu'on sait d'une étape : accomplie, passée, ou pas encore traitée. */
export type OnboardingStepOutcome = 'done' | 'skipped' | 'todo';

export function onboardingStepOutcome(
  state: OnboardingState,
  step: OnboardingStepId,
): OnboardingStepOutcome {
  if (state.completed.includes(step)) return 'done';
  if (state.skipped.includes(step)) return 'skipped';
  return 'todo';
}

/**
 * Étape enrichie de son état, telle que la rendent l'API et la page. Une seule
 * fonction pour les deux : l'écran ne doit pas pouvoir afficher une progression
 * différente de celle que l'API rapporte.
 */
export type OnboardingPresentedStep = OnboardingStepDefinition & {
  outcome: OnboardingStepOutcome;
  current: boolean;
};

export function presentOnboardingSteps(
  state: OnboardingState,
  steps: readonly OnboardingStepDefinition[],
): OnboardingPresentedStep[] {
  return steps.map((step) => ({
    ...step,
    outcome: onboardingStepOutcome(state, step.id),
    current: state.currentStep === step.id,
  }));
}

function withoutStep(steps: readonly OnboardingStepId[], step: OnboardingStepId) {
  return steps.filter((entry) => entry !== step);
}

/**
 * Étape suivante parmi celles qui concernent la personne. Rend `summary` quand
 * il n'y a plus rien après — le parcours a toujours une fin visible.
 */
export function nextOnboardingStep(
  from: OnboardingStepId,
  steps: readonly OnboardingStepDefinition[],
): OnboardingStepId {
  const order = steps.map((step) => step.id);
  const index = order.indexOf(from);
  if (index < 0) return order[0] ?? 'summary';
  return order[index + 1] ?? order[order.length - 1] ?? 'summary';
}

/**
 * Transitions du parcours. Écrites ici, en un seul endroit, plutôt que dans le
 * handler HTTP : le panel, le script de vérification et l'écran de relance
 * doivent tous produire exactement les mêmes états.
 */
export type OnboardingAction =
  | { kind: 'offer' }
  | { kind: 'goto'; step: OnboardingStepId }
  | { kind: 'complete'; step: OnboardingStepId }
  | { kind: 'skip'; step: OnboardingStepId }
  | { kind: 'finish' }
  | { kind: 'dismiss' }
  | { kind: 'restart' };

export function applyOnboardingAction(
  current: OnboardingState,
  action: OnboardingAction,
  steps: readonly OnboardingStepDefinition[],
  now: Date = new Date(),
): OnboardingState {
  const stamp = now.toISOString();

  switch (action.kind) {
    case 'offer':
      // Idempotent : ne repasse jamais un parcours soldé en cours.
      if (current.status !== 'pending') return current;
      return {
        ...current,
        status: 'in_progress',
        offeredAt: current.offeredAt ?? stamp,
      };

    case 'goto':
      return { ...current, status: 'in_progress', currentStep: action.step };

    case 'complete':
      return {
        ...current,
        status: 'in_progress',
        offeredAt: current.offeredAt ?? stamp,
        completed: [...withoutStep(current.completed, action.step), action.step],
        // Accomplir efface le fait de l'avoir passée : les deux ne coexistent pas.
        skipped: withoutStep(current.skipped, action.step),
        currentStep: nextOnboardingStep(action.step, steps),
      };

    case 'skip':
      return {
        ...current,
        status: 'in_progress',
        offeredAt: current.offeredAt ?? stamp,
        skipped: [...withoutStep(current.skipped, action.step), action.step],
        completed: withoutStep(current.completed, action.step),
        currentStep: nextOnboardingStep(action.step, steps),
      };

    case 'finish':
      return {
        ...current,
        status: 'completed',
        currentStep: 'summary',
        offeredAt: current.offeredAt ?? stamp,
        finishedAt: stamp,
        dismissedAt: null,
      };

    case 'dismiss':
      return {
        ...current,
        status: 'dismissed',
        offeredAt: current.offeredAt ?? stamp,
        dismissedAt: stamp,
        finishedAt: null,
      };

    case 'restart':
      // Repart de zéro, mais garde la trace du nombre de passages : « jamais
      // lancé » et « relancé trois fois puis abandonné » ne se ressemblent pas.
      return {
        status: 'pending',
        currentStep: 'welcome',
        completed: [],
        skipped: [],
        offeredAt: null,
        finishedAt: null,
        dismissedAt: null,
        runs: current.runs + 1,
      };
  }
}

/**
 * Champs **sans défaut**. C'est la forme de référence : le patch partiel en
 * dérive directement.
 *
 * Piège que cette séparation évite : `z.string().default('X').optional()` rend
 * quand même `'X'` quand la clé est absente, au lieu de laisser le champ
 * absent. Un PATCH ne portant que le fuseau produirait alors un objet complet
 * de valeurs par défaut, et réinitialiserait silencieusement le nom de
 * l'instance. Le défaut n'est donc appliqué que sur le schéma de *lecture*.
 */
const appSettingsFields = {
  /** Nom affiché en haut à gauche et dans le titre du document. */
  instanceName: z.string().trim().min(1).max(40),
  instanceTagline: z.string().trim().max(60),
  timezone: timeZoneSchema,
  locale: z.enum(SUPPORTED_LOCALES),
  dateStyle: z.enum(DATE_STYLES),
  timeStyle: z.enum(DATE_STYLES),
};

const FIELD_DEFAULTS = {
  instanceName: 'Pupitre',
  instanceTagline: 'Plan de contrôle de déploiement',
  timezone: DEFAULT_TIMEZONE,
  locale: 'fr-FR',
  dateStyle: 'short',
  timeStyle: 'medium',
} as const;

/**
 * Forme de lecture, défauts compris. Exposée séparément de
 * `appSettingsSchema` pour que la lecture tolérante (`parseAppSettings`) puisse
 * revalider un champ isolé sans rejeter tout l'objet.
 */
export const appSettingsShape = {
  instanceName: appSettingsFields.instanceName.default(FIELD_DEFAULTS.instanceName),
  instanceTagline: appSettingsFields.instanceTagline.default(FIELD_DEFAULTS.instanceTagline),
  timezone: appSettingsFields.timezone.default(FIELD_DEFAULTS.timezone),
  locale: appSettingsFields.locale.default(FIELD_DEFAULTS.locale),
  dateStyle: appSettingsFields.dateStyle.default(FIELD_DEFAULTS.dateStyle),
  timeStyle: appSettingsFields.timeStyle.default(FIELD_DEFAULTS.timeStyle),
  ai: aiSettingsSchema.default(DEFAULT_AI_SETTINGS),
  security: securitySettingsSchema.default(DEFAULT_SECURITY_SETTINGS),
  sso: ssoSettingsSchema.default(DEFAULT_SSO_SETTINGS),
  accounts: accountsSettingsSchema.default(DEFAULT_ACCOUNTS_SETTINGS),
  /**
   * Avancement de l'assistant de démarrage. Il est dans la forme de *lecture*
   * mais volontairement absent de `appSettingsPatchSchema` : `PATCH
   * /api/settings` ne doit pas pouvoir déclarer un parcours terminé au détour
   * d'un changement de fuseau. Sa présence ici est en revanche indispensable —
   * `mergeAppSettings()` revalide l'objet entier, et un champ hors schéma
   * serait silencieusement effacé au premier enregistrement des paramètres.
   */
  onboarding: onboardingStateSchema.default(DEFAULT_ONBOARDING_STATE),
};

export const appSettingsSchema = z.object(appSettingsShape);

export type AppSettings = z.infer<typeof appSettingsSchema>;

export const DEFAULT_APP_SETTINGS: AppSettings = appSettingsSchema.parse({});

/**
 * Patch partiel accepté par `PATCH /api/settings`. Bâti sur les champs sans
 * défaut : une clé absente reste absente, et ne réinitialise donc rien.
 * `ai` est partiel lui aussi — régler `ai.enabled` ne doit pas effacer le modèle.
 */
export const appSettingsPatchSchema = z.object({
  instanceName: appSettingsFields.instanceName.optional(),
  instanceTagline: appSettingsFields.instanceTagline.optional(),
  timezone: appSettingsFields.timezone.optional(),
  locale: appSettingsFields.locale.optional(),
  dateStyle: appSettingsFields.dateStyle.optional(),
  timeStyle: appSettingsFields.timeStyle.optional(),
  ai: aiSettingsPatchSchema.optional(),
  security: securitySettingsPatchSchema.optional(),
  sso: ssoSettingsPatchSchema.optional(),
  accounts: accountsSettingsPatchSchema.optional(),
});

export type AppSettingsPatch = z.infer<typeof appSettingsPatchSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Lecture tolérante : rend toujours un objet complet.
 *
 * Si l'objet entier passe le schéma, on s'arrête là. Sinon on reprend champ par
 * champ et on ne retient que ceux qui valident — un seul réglage devenu invalide
 * (schéma durci entre deux versions, retouche en SQL à la main) ne doit pas
 * faire retomber toute l'instance sur ses défauts, ni casser l'affichage.
 */
export function parseAppSettings(raw: unknown): AppSettings {
  const direct = appSettingsSchema.safeParse(raw ?? {});
  if (direct.success) return direct.data;

  const source = isRecord(raw) ? raw : {};
  const salvaged: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(appSettingsShape)) {
    const field = schema.safeParse(source[key]);
    // Une clé absente déclenche le `.default()` du champ à la reconstruction.
    if (field.success) salvaged[key] = field.data;
  }
  return appSettingsSchema.parse(salvaged);
}

/**
 * Fusion superficielle d'un patch sur des paramètres existants.
 * `ai` est le seul objet imbriqué : il se fusionne, il ne s'écrase pas — un
 * PATCH qui ne porte que `ai.enabled` ne doit pas réinitialiser le modèle.
 */
/** Un objet simple, par opposition à un tableau ou à `null`. */
function isSection(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function mergeAppSettings(current: AppSettings, patch: AppSettingsPatch): AppSettings {
  /**
   * Fusion **sur un niveau**, et pas davantage.
   *
   * Un niveau parce que les sections (`ai`, `security`) contiennent des
   * scalaires et des tableaux : `disabledScanners: ['syft']` doit *remplacer*
   * la liste courante, pas s'y ajouter. Fusionner plus profond rendrait
   * impossible de retirer un scanner de la liste.
   *
   * Mais au moins un niveau, sinon un PATCH ne parlant que de
   * `security.scanningEnabled` remplacerait toute la section, et le schéma de
   * lecture comblerait les clés manquantes par leurs défauts — réinitialisant
   * en silence les scanners écartés et le seuil de blocage. Ce défaut a
   * réellement existé : la fusion profonde n'était câblée que pour `ai`, et
   * `security` retombait dans le cas général sans que rien ne le signale.
   * Traiter les sections par leur forme plutôt que par leur nom évite qu'une
   * section ajoutée demain hérite du même piège.
   */
  const merged: Record<string, unknown> = { ...current };

  for (const [key, value] of Object.entries(patch)) {
    // Une clé explicitement à `undefined` ne doit pas écraser la valeur
    // courante : l'écrasement retomberait sur le défaut du schéma.
    if (value === undefined) continue;

    const existing = merged[key];
    if (isSection(value) && isSection(existing)) {
      const section: Record<string, unknown> = { ...existing };
      for (const [field, fieldValue] of Object.entries(value)) {
        if (fieldValue !== undefined) section[field] = fieldValue;
      }
      merged[key] = section;
      continue;
    }

    merged[key] = value;
  }

  return appSettingsSchema.parse(merged);
}
