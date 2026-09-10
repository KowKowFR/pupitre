import type { Permission } from './permissions.js';
import { SCANNER_KEYS, scannerKeySchema, type ScanConfig, type ScannerKey } from './scan.js';
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
 * Ce module ne dépend que de Zod : il est importé par `@tp/db`, par le panel
 * et par le worker. La clé d'API de l'IA n'y figure volontairement pas — un
 * secret ne voyage pas avec de la configuration ordinaire, il vit dans sa
 * propre colonne chiffrée (cf. `app_settings.ai_api_key_encrypted`).
 */

/**
 * Modèle par défaut. Choisi pour sa fiabilité en sortie structurée, pas pour
 * son prix : une AppSpec mal formée coûte une relance, donc deux appels.
 *
 * Déclaré ici et non dans `ai/model.ts` pour que la racine de `@tp/core` — donc
 * `@tp/db` et le worker — puisse connaître le défaut sans tirer le SDK IA dans
 * son graphe de dépendances. `ai/model.ts` le réexporte sous son nom d'origine.
 */
export const DEFAULT_AI_MODEL = 'anthropic/claude-sonnet-4.5';

/** Locales proposées. Liste explicite : chacune doit avoir été relue en vrai. */
export const SUPPORTED_LOCALES = ['fr-FR', 'en-GB', 'en-US', 'de-DE', 'es-ES'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const DATE_STYLES = ['short', 'medium', 'long'] as const;
export type DateStyleName = (typeof DATE_STYLES)[number];

export const AI_PROVIDERS = ['openrouter'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

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

export const aiSettingsSchema = z.object({
  /** Un seul fournisseur pour l'instant ; l'énumération laisse la porte ouverte. */
  provider: z.enum(AI_PROVIDERS).default('openrouter'),
  model: z.string().trim().min(1).max(120).default(DEFAULT_AI_MODEL),
  enabled: z.boolean().default(true),
  temperature: z.number().min(0).max(1).default(0.2),
  maxTokens: z.number().int().min(256).max(200_000).default(8_192),
});

export type AiSettings = z.infer<typeof aiSettingsSchema>;

export const DEFAULT_AI_SETTINGS: AiSettings = {
  provider: 'openrouter',
  model: DEFAULT_AI_MODEL,
  enabled: true,
  temperature: 0.2,
  maxTokens: 8_192,
};

export const securitySettingsSchema = z.object({
  /**
   * Interrupteur général. À `false`, plus aucun scan ne sera lancé, sur aucun
   * déploiement, tant que le réglage n'est pas remis à `true`.
   */
  scanningEnabled: z.boolean().default(true),
  /**
   * Scanners écartés un par un, même quand l'analyse reste active. Permet de
   * couper Trivy sans renoncer à Grype, par exemple parce qu'un seul des deux
   * peut atteindre sa base de vulnérabilités depuis la machine cible.
   */
  disabledScanners: z.array(scannerKeySchema).max(SCANNER_KEYS.length).default([]),
});

export type SecuritySettings = z.infer<typeof securitySettingsSchema>;

export const DEFAULT_SECURITY_SETTINGS: SecuritySettings = {
  scanningEnabled: true,
  disabledScanners: [],
};

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
};

export const ONBOARDING_STEP_DEFINITIONS: readonly OnboardingStepDefinition[] = [
  {
    id: 'welcome',
    title: 'Bienvenue',
    summary: "Ce que ce panel fait, et ce qu'il ne fait pas.",
    requires: null,
    optional: false,
    cost: null,
  },
  {
    id: 'identity',
    title: 'Identité et régionalisation',
    summary: "Le nom de l'instance, son fuseau et sa locale.",
    requires: 'settings:manage',
    optional: false,
    cost: null,
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
  },
  {
    id: 'user',
    title: 'Un utilisateur',
    summary: 'Un compte pour quelqu’un d’autre que vous.',
    requires: 'user:manage',
    optional: true,
    cost:
      'Vous resterez seul à pouvoir vous connecter. Chaque geste du panel étant tracé avec son ' +
      'auteur, un compte partagé rend le journal d’audit inexploitable.',
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
  },
  {
    id: 'summary',
    title: 'Fin',
    summary: 'Ce qui a été fait, ce qui a été passé, et où y revenir.',
    requires: null,
    optional: false,
    cost: null,
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
  instanceName: 'Control plane',
  instanceTagline: 'Bootstrap TP v2',
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
  ai: aiSettingsSchema.partial().optional(),
  security: securitySettingsSchema.partial().optional(),
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
export function mergeAppSettings(current: AppSettings, patch: AppSettingsPatch): AppSettings {
  const { ai, ...rest } = patch;

  // Ceinture et bretelles : une clé explicitement à `undefined` ne doit pas
  // écraser la valeur courante — l'écrasement retomberait sur le défaut du
  // schéma, ce qui reviendrait à réinitialiser un champ qu'on n'a pas touché.
  const defined: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) defined[key] = value;
  }

  const aiDefined: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(ai ?? {})) {
    if (value !== undefined) aiDefined[key] = value;
  }

  return appSettingsSchema.parse({
    ...current,
    ...defined,
    ai: { ...current.ai, ...aiDefined },
  });
}
