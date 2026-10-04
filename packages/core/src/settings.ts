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
 * Instance settings — the single schema of truth.
 *
 * Stored in the database in **a single JSONB column**, not one column per
 * setting: adding a setting must not cost a migration. The price to pay is that
 * the database no longer guarantees the content's shape — hence this schema,
 * applied on each read, which fills absent fields with their default. An empty
 * database, a truncated JSON or a field added afterwards therefore always return
 * a complete, valid object.
 *
 * This module only depends on Zod: it is imported by `@pupitre/db`, by the panel
 * and by the worker. The AI API key is deliberately not in it — a secret does
 * not travel with ordinary configuration, it lives in its own encrypted column
 * (see `app_settings.ai_api_key_encrypted`).
 */

/**
 * A new instance's default model — OpenRouter's, the default provider. Each
 * provider has its own: `defaultAiModel(provider)` is the function to call as
 * soon as we know which provider we are talking about.
 *
 * The catalog lives under `ai/catalog.ts` but depends on nothing: the root of
 * `@pupitre/core` — hence `@pupitre/db` and the worker — can therefore know the
 * list of providers and their defaults without pulling the AI SDK into its graph.
 */
export const DEFAULT_AI_MODEL = defaultAiModel('openrouter');

/** Offered locales. An explicit list: each one must have been proofread for real. */
export const SUPPORTED_LOCALES = ['fr-FR', 'en-GB', 'en-US', 'de-DE', 'es-ES'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/**
 * The locales the selector offers — those whose language the panel really
 * speaks.
 *
 * `SUPPORTED_LOCALES` stays wider, deliberately: an instance that already
 * carries `de-DE` in its database keeps reading without its validation failing
 * at startup. It simply gets the interface in English (see `languageOf()`) and
 * will no longer find "Deutsch" in the list. Offering a choice that only half
 * changes the screen would be worse than not offering it.
 *
 * Adding a language means writing its dictionary, adding it to `UI_LANGUAGES`,
 * then adding its locale here. In that order.
 */
export const TRANSLATED_LOCALES = ['fr-FR', 'en-GB', 'en-US'] as const;

/**
 * How each locale names itself **in its own language**. An English speaker who
 * lands on an instance in French must recognize their line without being able
 * to read the others — it is the only string in the panel that is not
 * translated.
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
 * An invalid time zone in the database would crash every page render: we refuse
 * it on input rather than discover it on display. `Intl` is the only reliable
 * judge — the list of time zones depends on the embedded ICU version, not on an
 * enumeration we would freeze in the code.
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

/** Time zones known to this runtime, to feed a dropdown list. */
export function supportedTimeZones(): string[] {
  try {
    return [...Intl.supportedValuesOf('timeZone')];
  } catch {
    // A runtime without full ICU: we return at least enough to choose.
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
 * Fields of the AI section, **without defaults** — the same precaution as for
 * the root fields below, and for the same reason:
 * `schema.default(x).optional()` returns `x` when the key is absent. A
 * `PATCH { ai: { enabled: false } }` therefore went off with a complete `ai`
 * object of default values, and silently reset the instance's provider, model
 * and temperature. The default is only applied on the *read* schema.
 */
const aiFields = {
  /** A list derived from the catalog: an added provider shows up without touching anything here. */
  provider: z.enum(AI_PROVIDERS),
  /**
   * Model identifier, in the chosen provider's convention. The default cannot
   * depend on the provider in a flat object schema: it is `resolveAiConfig()`
   * that falls back on `defaultAiModel(provider)` when the field is empty, and
   * `aiModelMismatch()` that flags an identifier visibly belonging to another
   * provider.
   */
  model: z.string().trim().min(1).max(120),
  /**
   * URL of a self-hosted OpenAI-compatible API. Validated as a URL — a shaky
   * value here would fail every generation without saying anything. Ignored by
   * the providers that do not declare it (`supportsBaseUrl`).
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

/** Partial patch of the AI section: an absent key stays absent. */
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
 * Fields of the security section, **without defaults** — the reference shape.
 *
 * The same split as for AI and for the settings' root, and for the same reason:
 * `schema.partial()` on fields carrying `.default()` **still fills** those
 * defaults for absent keys. A PATCH only about `scanningEnabled` therefore
 * silently reset the set-aside scanners and the blocking threshold — a security
 * policy unravelled by a gesture that was not aimed at it.
 */
const securityFields = {
  /**
   * Main switch. At `false`, no scan will be started anymore, on any deployment,
   * until the setting is set back to `true`.
   */
  scanningEnabled: z.boolean(),
  /**
   * Scanners set aside one by one, even when scanning stays on. It allows
   * turning off Trivy without giving up Grype, for example because only one of
   * the two can reach its vulnerability database from the target machine.
   */
  disabledScanners: z.array(scannerKeySchema).max(SCANNER_KEYS.length),
  /**
   * Severity from which a finding blocks the release.
   *
   * It lives here since the deployment screen stopped asking for it: a security
   * policy chosen case by case, deployment by deployment, is not a policy.
   *
   * The default is `NONE` — we scan and report, we do not block. Blocking right
   * away looks safer and is not: `nginx:1.29-alpine` carries 26 CRITICAL
   * findings, `httpd:2.4-alpine` carries 40. A blocking threshold by default
   * therefore refuses every public image from the first release, and the operator
   * turns off scanning entirely to move on — ending up with no scan at all. Inform
   * by default, block by decision.
   */
  failOn: failOnSchema,
  /**
   * Only block on **fixable** vulnerabilities. It is what makes a threshold
   * bearable on public images: most of their CRITICAL ones have no fix, and there
   * is no point blocking on what no update fixes. An application can decide
   * otherwise.
   */
  onlyFixable: z.boolean(),
};

/** Read: the defaults fill what an old database does not carry. */
export const securitySettingsSchema = z.object({
  scanningEnabled: securityFields.scanningEnabled.default(true),
  disabledScanners: securityFields.disabledScanners.default([]),
  failOn: securityFields.failOn.default('NONE'),
  onlyFixable: securityFields.onlyFixable.default(false),
});

/** Partial patch: an absent key stays absent. */
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
 * Single sign-on through OpenID Connect — Keycloak, Authentik, Google, Entra:
 * any provider that publishes a discovery document.
 *
 * The client secret is **not** here: like the AI key, it has its encrypted
 * column (`app_settings.sso_client_secret_encrypted`). What is here can be read,
 * returned by the API and written to the audit log without exposing anything.
 *
 * The same fields without defaults as the other sections, for the same reason:
 * a PATCH only about `enabled` must not erase the role mappings.
 */
const ssoFields = {
  enabled: z.boolean(),
  /** The button's text: "Sign in with Keycloak". */
  label: z.string().trim().min(1).max(40),
  /**
   * The issuer, as the provider announces it: for Keycloak,
   * `https://auth.example.com/realms/my-realm`. The discovery is read at
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
  /** The requested scopes, space-separated. `openid` is always added. */
  scopes: z.string().trim().max(300),
  /** Create the account at the first sign-in. Otherwise, only existing accounts get in. */
  autoCreate: z.boolean(),
  /**
   * Link the sign-in to an existing account with the same email — only when the
   * provider declares that email verified.
   */
  linkByEmail: z.boolean(),
  /** Where to read groups in the profile: `groups`, or a path like `realm_access.roles`. */
  groupsClaim: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[\w:-]+(\.[\w:-]+)*$/, 'chemin de champ attendu, ex. groups ou realm_access.roles'),
  /** Provider group → Pupitre role. The first match wins. */
  roleMappings: z
    .array(
      z.object({
        group: z.string().trim().min(1).max(200),
        role: z.string().trim().min(1).max(60),
      }),
    )
    .max(50),
  /** The role of whoever has no recognized group. */
  defaultRole: z.string().trim().min(1).max(60),
  /** Apply the mappings again at each sign-in: the provider is authoritative. */
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
 * Accounts and their sessions: who must carry a second factor, and how long a
 * session stays open.
 *
 * Durations are in hours, chosen from a short list: a free duration invites
 * values nobody ever reads again (a 9,999-hour session).
 */
export const SESSION_IDLE_HOURS = [1, 8, 24, 168, 720] as const;
export const SESSION_MAX_HOURS = [24, 168, 720] as const;

const accountsFields = {
  /**
   * `off`: nobody is bound by it. `sensitive`: any role that carries a sensitive
   * permission (`SENSITIVE_PERMISSIONS`). `all`: every account.
   */
  twoFactorPolicy: z.enum(TWO_FACTOR_POLICIES),
  /** Without activity for this duration, the session closes. Any request extends it. */
  sessionIdleHours: z.union(
    SESSION_IDLE_HOURS.map((hours) => z.literal(hours)) as unknown as [
      z.ZodLiteral<1>,
      z.ZodLiteral<8>,
      z.ZodLiteral<24>,
      z.ZodLiteral<168>,
      z.ZodLiteral<720>,
    ],
  ),
  /** Beyond this, the session closes even when active: sign in again. `null`: no cap. */
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
 * The instance's scan policy, as it applies to a deployment that asks for none
 * in particular.
 *
 * It is the counterpart of `applySecuritySettings`: that one vetoes an explicit
 * request, this one provides the policy when nobody states one. Before the
 * settings existed, the absence of configuration meant "no scan" — defensible
 * when the deployment screen carried the choice, untenable since it no longer
 * does: removing three checkboxes would have silently disarmed the scanning of
 * every release.
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
 * Applies the security settings to a requested scan configuration.
 *
 * Called **at enqueue time**, not in the worker: the configuration is frozen in
 * the deployment, and it must tell the truth about what is going to run.
 * Filtering it later would leave in the database the trace of a scanner that
 * never ran — a lasting lie, in the only column used afterwards to understand
 * what was checked.
 *
 * Accepted consequence: turning scanning back on does not act retroactively on
 * deployments already enqueued. It is the same freezing semantics as the
 * AppSpec.
 */
export function applySecuritySettings(
  requested: ScanConfig,
  security: SecuritySettings,
): ScanConfig {
  if (!security.scanningEnabled) {
    // `failOn` falls back to NONE: keeping a blocking threshold with nothing to
    // evaluate it would make a promise nobody keeps.
    return { ...requested, scanners: [], failOn: 'NONE', disabledBy: 'settings' };
  }

  // A request that says nothing about fixable ones follows the instance.
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
   Setup guide
   ------------------------------------------------------------------------- */

/**
 * The steps, in the guide's order. The order is not decorative: it goes from
 * the most general to the most specific, and each step only depends on the
 * previous ones. `welcome` situates the panel before asking anything;
 * `identity` commits nothing external; `target` is the only one that touches a
 * machine; `proxy` follows it: a machine's reverse proxy is set once it exists;
 * `role` then `user` come after it because a role is used to give access to
 * something that exists — inviting someone onto a panel without a target is
 * pointless; `security` sets what will apply to future deployments; `summary`
 * only reports.
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
 * Four states, because three distinct questions need an answer and a boolean
 * only covers one:
 *
 *   `pending`     — never offered. It is the state of a new installation.
 *   `in_progress` — offered at least once, neither finished nor abandoned. It
 *                   is here that `currentStep` makes sense: we resume where we
 *                   left off.
 *   `dismissed`   — deliberately abandoned ("I'll deal with it later"). It is
 *                   not "completed": the summary will always say what was not
 *                   done.
 *   `completed`   — gone through to the end.
 *
 * Confusing `dismissed` and `completed` would amount to claiming an
 * installation is configured when nobody did anything; confusing `pending` and
 * `in_progress` would make whoever closes their browser in the middle start
 * over.
 */
export const ONBOARDING_STATUSES = ['pending', 'in_progress', 'dismissed', 'completed'] as const;
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];

/**
 * ISO timestamp. `Date.parse` rather than a fixed format: the value comes from
 * `toISOString()`, and the only thing to guarantee is that it reads back.
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
  /** Where we resume. Only makes sense while the guide is not settled. */
  currentStep: z.enum(ONBOARDING_STEPS).default('welcome'),
  /** Completed steps — something was really created or saved. */
  completed: onboardingStepList,
  /** Steps knowingly skipped. Distinct from "completed", and from "not seen yet". */
  skipped: onboardingStepList,
  /** First time the guide was shown to someone. */
  offeredAt: onboardingTimestamp,
  finishedAt: onboardingTimestamp,
  dismissedAt: onboardingTimestamp,
  /** Number of restarts from the settings. Zero for the original run. */
  runs: z.number().int().min(0).max(10_000).default(0),
});

export type OnboardingState = z.infer<typeof onboardingStateSchema>;

export const DEFAULT_ONBOARDING_STATE: OnboardingState = onboardingStateSchema.parse({});

/**
 * What a step is, once the prose is removed.
 *
 * The title, the summary, the detail and the price to pay for skipping it used
 * to live here. They moved to `apps/web/src/i18n/messages/onboarding.ts`, under
 * `step.<id>.*`: it was display, nothing in this package read them, and keeping
 * them would have forced the catalog to carry two languages per field. What
 * remains decides — which permission the step requires, and whether it can be
 * skipped — and depends on no language.
 */
export type OnboardingStepDefinition = {
  id: OnboardingStepId;
  /**
   * Permission without which the step would end in a 403. `null` for the steps
   * that create nothing (`welcome`, `summary`): they open no right and are never
   * enough, on their own, to justify the guide.
   */
  requires: Permission | null;
  /**
   * Optional: it can be skipped explicitly. The dictionary's `step.<id>.cost` key
   * then says what is lost, and it only exists for those steps — a "Skip" button
   * without an announced consequence is not an informed choice. `optional` is
   * therefore enough to know whether the price can be read.
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
  // Impossible by typing; the guard exists for the JSON read back from the database.
  if (!step) throw new Error(`Unknown onboarding step: ${id}`);
  return step;
}

/**
 * Steps kept for a given person.
 *
 * A step that cannot be done is not greyed out, it is **absent**: offering a
 * form whose save will end in a 403 is worse than offering nothing at all.
 * `welcome` and `summary` require nothing and always frame the guide — but only
 * if something remains between the two.
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
 * Does the guide concern this person? False for a viewer: there is nothing they
 * can do, the screen would only teach them to read refusals.
 */
export function onboardingApplies(can: (permission: Permission) => boolean): boolean {
  return ONBOARDING_STEP_DEFINITIONS.some(
    (step) => step.requires !== null && can(step.requires),
  );
}

/** Settled: nothing left to resume, one way or the other. */
export function isOnboardingSettled(state: OnboardingState): boolean {
  return state.status === 'completed' || state.status === 'dismissed';
}

/** What is known about a step: completed, skipped, or not handled yet. */
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
 * A step enriched with its state, as the API and the page return it. A single
 * function for both: the screen must not be able to show a progress different
 * from the one the API reports.
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
 * Next step among those that concern the person. Returns `summary` when nothing
 * remains after — the guide always has a visible end.
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
 * The guide's transitions. Written here, in a single place, rather than in the
 * HTTP handler: the panel, the verification script and the restart screen must
 * all produce exactly the same states.
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
      // Idempotent: never puts a settled guide back in progress.
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
        // Completing erases having skipped it: the two do not coexist.
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
      // Starts from scratch, but keeps track of the number of runs: "never run" and
      // "run three times then abandoned" do not look alike.
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
 * Fields **without defaults**. It is the reference shape: the partial patch
 * derives from it directly.
 *
 * The trap this split avoids: `z.string().default('X').optional()` still returns
 * `'X'` when the key is absent, instead of leaving the field absent. A PATCH
 * carrying only the time zone would then produce a complete object of default
 * values, and silently reset the instance's name. The default is therefore only
 * applied on the *read* schema.
 */
const appSettingsFields = {
  /** Name shown at the top left and in the document title. */
  instanceName: z.string().trim().min(1).max(40),
  instanceTagline: z.string().trim().max(60),
  timezone: timeZoneSchema,
  locale: z.enum(SUPPORTED_LOCALES),
  dateStyle: z.enum(DATE_STYLES),
  timeStyle: z.enum(DATE_STYLES),
};

/**
 * Defaults of a new instance, in English: the setup guide offers to change the
 * language at the first sign-in. Instances installed before the switch keep the
 * French values they were born with (migration `0047_english_defaults`).
 */
const FIELD_DEFAULTS = {
  instanceName: 'Pupitre',
  instanceTagline: 'Deployment control plane',
  timezone: DEFAULT_TIMEZONE,
  locale: 'en-US',
  dateStyle: 'short',
  timeStyle: 'medium',
} as const;

/**
 * Read shape, defaults included. Exposed separately from `appSettingsSchema` so
 * that the tolerant read (`parseAppSettings`) can validate a single field again
 * without rejecting the whole object.
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
   * Progress of the setup guide. It is in the *read* shape but deliberately
   * absent from `appSettingsPatchSchema`: `PATCH /api/settings` must not be able
   * to declare a guide finished in passing during a time zone change. Its
   * presence here is however essential — `mergeAppSettings()` validates the whole
   * object again, and a field outside the schema would be silently erased at the
   * first save of the settings.
   */
  onboarding: onboardingStateSchema.default(DEFAULT_ONBOARDING_STATE),
};

export const appSettingsSchema = z.object(appSettingsShape);

export type AppSettings = z.infer<typeof appSettingsSchema>;

export const DEFAULT_APP_SETTINGS: AppSettings = appSettingsSchema.parse({});

/**
 * Partial patch accepted by `PATCH /api/settings`. Built on the fields without
 * defaults: an absent key stays absent, and therefore resets nothing. `ai` is
 * partial too — setting `ai.enabled` must not erase the model.
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
 * Tolerant read: always returns a complete object.
 *
 * If the whole object passes the schema, we stop there. Otherwise we go field by
 * field and only keep those that validate — a single setting that became
 * invalid (schema tightened between two versions, hand-edited in SQL) must not
 * make the whole instance fall back on its defaults, nor break the display.
 */
export function parseAppSettings(raw: unknown): AppSettings {
  const direct = appSettingsSchema.safeParse(raw ?? {});
  if (direct.success) return direct.data;

  const source = isRecord(raw) ? raw : {};
  const salvaged: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(appSettingsShape)) {
    const field = schema.safeParse(source[key]);
    // An absent key triggers the field's `.default()` on reconstruction.
    if (field.success) salvaged[key] = field.data;
  }
  return appSettingsSchema.parse(salvaged);
}

/**
 * Shallow merge of a patch onto existing settings. `ai` is the only nested
 * object: it is merged, not overwritten — a PATCH carrying only `ai.enabled`
 * must not reset the model.
 */
/** A plain object, as opposed to an array or `null`. */
function isSection(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function mergeAppSettings(current: AppSettings, patch: AppSettingsPatch): AppSettings {
  /**
   * Merge **one level deep**, and no more.
   *
   * One level because the sections (`ai`, `security`) contain scalars and
   * arrays: `disabledScanners: ['syft']` must *replace* the current list, not add
   * to it. Merging deeper would make it impossible to remove a scanner from the
   * list.
   *
   * But at least one level, otherwise a PATCH only about
   * `security.scanningEnabled` would replace the whole section, and the read
   * schema would fill the missing keys with their defaults — silently resetting
   * the set-aside scanners and the blocking threshold. That defect really
   * existed: the deep merge was only wired for `ai`, and `security` fell into the
   * general case without anything reporting it. Treating sections by their shape
   * rather than their name keeps a section added tomorrow from inheriting the same
   * trap.
   */
  const merged: Record<string, unknown> = { ...current };

  for (const [key, value] of Object.entries(patch)) {
    // A key explicitly set to `undefined` must not overwrite the current value:
    // overwriting would fall back on the schema's default.
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
