import type { Permission } from './permissions.js';
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

export const DATE_STYLES = ['short', 'medium', 'long'] as const;
export type DateStyleName = (typeof DATE_STYLES)[number];

export {
  AI_MODEL_TIER_LABELS,
  AI_PROVIDERS,
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
};

/** Lecture : les défauts comblent ce qu'une base ancienne ne porte pas. */
export const securitySettingsSchema = z.object({
  scanningEnabled: securityFields.scanningEnabled.default(true),
  disabledScanners: securityFields.disabledScanners.default([]),
  failOn: securityFields.failOn.default('NONE'),
});

/** Patch partiel : une clé absente reste absente. */
export const securitySettingsPatchSchema = z.object({
  scanningEnabled: securityFields.scanningEnabled.optional(),
  disabledScanners: securityFields.disabledScanners.optional(),
  failOn: securityFields.failOn.optional(),
});

export type SecuritySettings = z.infer<typeof securitySettingsSchema>;

export const DEFAULT_SECURITY_SETTINGS: SecuritySettings = {
  scanningEnabled: true,
  disabledScanners: [],
  failOn: 'NONE',
};

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

  return { scanners: [...scanners], failOn: security.failOn };
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

  const disabled = new Set<ScannerKey>(security.disabledScanners);
  const kept = requested.scanners.filter((scanner) => !disabled.has(scanner));
  if (kept.length === requested.scanners.length) return requested;

  return {
    ...requested,
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
 * `role` puis `user` viennent après elle parce qu'un rôle sert à donner accès
 * à quelque chose qui existe — inviter quelqu'un sur un panel sans cible n'a
 * pas d'objet ; `security` règle ce qui s'appliquera aux déploiements à venir ;
 * `summary` ne fait que rendre compte.
 */
export const ONBOARDING_STEPS = [
  'welcome',
  'identity',
  'target',
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

export type OnboardingStepDefinition = {
  id: OnboardingStepId;
  title: string;
  /** Une phrase, affichée sous le titre de l'étape. */
  summary: string;
  /**
   * Permission sans laquelle l'étape finirait en 403. `null` pour les étapes
   * qui ne créent rien (`welcome`, `summary`) : elles n'ouvrent aucun droit et
   * ne suffisent jamais, à elles seules, à justifier l'assistant.
   */
  requires: Permission | null;
  /**
   * Facultative : elle peut être passée explicitement. `cost` dit alors ce
   * qu'on perd — un bouton «&nbsp;Passer&nbsp;» sans conséquence annoncée
   * n'est pas un choix éclairé.
   */
  optional: boolean;
  cost: string | null;
  /**
   * Ce que l'étape fait vraiment, en deux ou trois phrases.
   *
   * Vit ici plutôt que dans le JSX parce que c'est du contenu, pas de la mise
   * en page : il doit être lisible par l'écran de l'assistant comme par un
   * récapitulatif, sans que deux versions du texte se mettent à diverger.
   */
  detail: string;
};

export const ONBOARDING_STEP_DEFINITIONS: readonly OnboardingStepDefinition[] = [
  {
    id: 'welcome',
    title: 'Bienvenue',
    summary: "Ce que ce panel fait, et ce qu'il ne fait pas.",
    requires: null,
    optional: false,
    cost: null,
    detail:
      "Ce panel orchestre, il n'héberge pas. Il se connecte en SSH à des machines que " +
      "vous possédez déjà et y installe vos applications, en Docker Compose ou en " +
      "Kubernetes selon la cible. Rien de ce que vous déployez ne tourne ici : ce " +
      "conteneur-ci ne porte que le panel, sa base et sa file de tâches.",
  },
  {
    id: 'identity',
    title: 'Identité et régionalisation',
    summary: "Le nom de l'instance, son fuseau et sa locale.",
    requires: 'settings:manage',
    optional: false,
    cost: null,
    detail:
      "Le nom apparaît en haut à gauche et dans le titre de l'onglet — utile dès qu'on " +
      "administre deux instances. Le fuseau et la locale ne sont pas cosmétiques : " +
      "toutes les dates affichées en dépendent, et une tâche planifiée « à 3 h » " +
      "prendra ce fuseau par défaut. Ces réglages se changent à tout moment depuis les " +
      "paramètres.",
  },
  {
    id: 'target',
    title: 'Première cible',
    summary: 'La machine Linux sur laquelle le panel déploiera, jointe en SSH.',
    requires: 'target:create',
    optional: true,
    cost:
      "Sans cible déclarée, rien ne peut être déployé : les écrans d'application et de " +
      'déploiement resteront sans destination. Vous pourrez la déclarer plus tard depuis ' +
      '« Cibles → Ajouter une cible ».',
    detail:
      "Une cible est une machine Linux joignable en SSH, avec Docker ou K3s installé. " +
      "Le panel y construit vos images et y lance vos conteneurs ; il n'y a aucun " +
      "registre d'images intermédiaire. La clé SSH que vous collez est chiffrée en " +
      "AES-256-GCM avant d'atteindre la base, et n'en ressort jamais en clair.",
  },
  {
    id: 'role',
    title: 'Un rôle',
    summary: 'Un jeu de permissions taillé pour votre équipe.',
    requires: 'role:manage',
    optional: true,
    cost:
      'Les trois rôles installés d’office (administrateur, opérateur, observateur) restent ' +
      'disponibles. Vous n’aurez simplement pas de rôle intermédiaire : toute personne à qui ' +
      'il faut plus que la lecture recevra les droits complets d’un opérateur.',
    detail:
      "Un rôle est un jeu de permissions du type « ressource:action » — par exemple « " +
      "deployment:create » ou « target:delete ». Les rôles sont des données, pas du " +
      "code : vous pouvez en créer autant que nécessaire et modifier leurs permissions " +
      "à chaud. Seul « administrateur » est verrouillé, pour qu'une instance ne puisse " +
      "jamais se retrouver sans personne capable de la réparer.",
  },
  {
    id: 'user',
    title: 'Un utilisateur',
    summary: 'Un compte pour quelqu’un d’autre que vous.',
    requires: 'user:manage',
    optional: true,
    cost:
      'Vous resterez seul à pouvoir vous connecter. Chaque geste du panel étant tracé avec son ' +
      'auteur, un compte partagé rend les logs d’activité inexploitables.',
    detail:
      "Chaque compte porte un rôle, et chaque geste du panel est tracé avec son auteur " +
      "dans les logs d'activité. Créer un compte par personne plutôt que d'en " +
      "partager un rend ces logs exploitables. Chacun pourra ensuite protéger son accès par un " +
      "second facteur depuis son espace personnel.",
  },
  {
    id: 'security',
    title: 'Sécurité et IA',
    summary: 'Les scanners d’images, et l’accès au modèle qui rédige les AppSpec.',
    requires: 'settings:manage',
    optional: true,
    cost:
      'Les scanners restent actifs avec leurs réglages par défaut. Sans clé d’API, la ' +
      'génération d’AppSpec par description restera indisponible et il faudra écrire le JSON ' +
      'à la main.',
    detail:
      "Les images sont analysées avant mise en ligne par Trivy, Grype et Syft, avec un " +
      "seuil de blocage réglable. Vous pouvez désactiver l'analyse durablement, ou " +
      "n'écarter qu'un scanner — utile quand un seul d'entre eux n'atteint pas sa base " +
      "de vulnérabilités. La clé d'API du modèle sert à rédiger une description " +
      "d'application à partir d'une phrase ; elle est chiffrée comme les clés SSH, et " +
      "le modèle ne produit jamais de commande shell, seulement du JSON validé.",
  },
  {
    id: 'summary',
    title: 'Fin',
    summary: 'Ce qui a été fait, ce qui a été passé, et où y revenir.',
    requires: null,
    optional: false,
    cost: null,
    detail:
      "Rien de ce qui a été passé n'est perdu : chaque étape correspond à un écran du " +
      "panel, atteignable à tout moment. Vous pouvez aussi relancer cet assistant " +
      "depuis les paramètres, autant de fois que vous voulez.",
  },
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
