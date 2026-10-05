/**
 * Catalog of AI providers — the *data* part of the abstraction.
 *
 * The same split as `Scanner` and `DeploymentDriver`: on one side a declarative
 * description (here), on the other a factory that instantiates
 * (`./providers.js`). The separation is not cosmetic — this module depends on
 * **nothing**, which lets `settings.ts`, hence `@pupitre/db` and the worker,
 * know the list of providers without pulling the AI SDK into their graph.
 *
 * Adding a fourth provider = one entry here, one entry in the factory. Neither
 * the routes, nor the UI, nor the settings schema, nor the panel's environment
 * schema have to change: everything that varies from one provider to another —
 * default model identifier, fallback environment variable, credentials shape —
 * is described here, never tested by an `if`.
 */

import { renderMessage, type Translated, type UiLanguage } from '../i18n.js';

/**
 * A model offered in the dropdown list.
 *
 * A suggestion, not a constraint: the field stays free. Catalogs move every
 * week, and freezing an enumeration in the code would prevent using a model
 * released after the panel's last update — exactly the kind of block we do not
 * want to inflict on ourselves.
 */
export type AiModelOption = {
  readonly id: string;
  /**
   * Indicative price in dollars per million tokens, **input then output**.
   *
   * Two numbers and not a ready-made string: "0,10 / 0,40" is a format, not data,
   * and the English instance writes "0.10 / 0.40". The catalog carries the
   * values, the screen carries the decimal separator.
   *
   * Taken on 2026-09-11; it will age. Shown as an order of magnitude to choose,
   * never as an invoice — the screen says so.
   */
  readonly price: readonly [input: number, output: number];
  readonly tier: 'economique' | 'equilibre' | 'capable';
};

export type AiProviderDescriptor = {
  /** Key stored in `app_settings.value.ai.provider`. */
  readonly key: string;
  readonly label: string;
  /**
   * Model used when nobody chose one. Each provider has its own identifier
   * convention: `anthropic/claude-sonnet-4.5` at OpenRouter, `claude-sonnet-4-5`
   * at Anthropic, `gpt-5.2` at OpenAI.
   */
  readonly defaultModel: string;
  /**
   * Example shown under the "Model" field, to tell the expected shape.
   *
   * **In the source language.** The identifier shown is not translated, but
   * "ex." and "fournisseur/modèle" are prose: the screen therefore goes through
   * `aiModelHint(provider, language)`, which reads the `aiModelHints` dictionary.
   * This field stays a French string, the dictionaries' source language — it is
   * what the tools and the checks that inspect the catalog without a language at
   * hand read.
   */
  readonly modelHint: string;
  /**
   * Fallback environment variable, **specific to the provider**.
   * `OPENROUTER_API_KEY` only holds for OpenRouter: reading it for Anthropic would
   * send a key to the wrong API, and the failure would be incomprehensible.
   */
  readonly envApiKeyVar: string | null;
  readonly envModelVar: string | null;
  /**
   * Customizable base URL. True for OpenAI-compatible APIs (vLLM, LiteLLM,
   * Ollama, an internal gateway), false otherwise.
   */
  readonly supportsBaseUrl: boolean;
  /**
   * Recognizes a **native** model identifier of the provider. Used to warn —
   * never to forbid: a custom base URL can serve any identifier.
   */
  readonly nativeModel: RegExp;
  /**
   * A few proven models, from the cheapest to the most capable.
   *
   * Generating an AppSpec means holding a structured JSON over several services:
   * tiny models at two cents per million fail at it, and "cheap" is worth nothing
   * if the answer is unusable. The entries below are the chosen compromise, not
   * the bottom of the catalog.
   *
   * **Reasoning** models (the `gpt-5` family, `o*`) are deliberately absent:
   * measured here, they exceed the generation route's bound. A recommended model
   * that times out is not a recommendation. Nothing prevents entering them by hand
   * if the bound is raised one day.
   */
  readonly models: readonly AiModelOption[];
};

const CATALOG = {
  openrouter: {
    key: 'openrouter',
    label: 'OpenRouter',
    defaultModel: 'anthropic/claude-sonnet-4.5',
    modelHint: 'fournisseur/modèle, ex. anthropic/claude-sonnet-4.5',
    envApiKeyVar: 'OPENROUTER_API_KEY',
    envModelVar: 'OPENROUTER_MODEL',
    supportsBaseUrl: false,
    // OpenRouter always prefixes with the model's publisher.
    nativeModel: /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i,
    models: [
      { id: 'google/gemini-2.5-flash-lite', price: [0.1, 0.4], tier: 'economique' },
      { id: 'deepseek/deepseek-chat-v3.1', price: [0.25, 0.95], tier: 'economique' },
      { id: 'openai/gpt-4.1-mini', price: [0.4, 1.6], tier: 'equilibre' },
      { id: 'anthropic/claude-haiku-4.5', price: [1, 5], tier: 'equilibre' },
      { id: 'anthropic/claude-sonnet-4.5', price: [3, 15], tier: 'capable' },
    ],
  },
  openai: {
    key: 'openai',
    label: 'OpenAI',
    defaultModel: 'gpt-4.1-mini',
    modelHint: 'ex. gpt-4.1-mini, gpt-4.1',
    envApiKeyVar: 'OPENAI_API_KEY',
    envModelVar: 'OPENAI_MODEL',
    // The only provider that accepts a base URL: it is its protocol that
    // self-hosted servers reimplement.
    supportsBaseUrl: true,
    nativeModel: /^(gpt-|chatgpt-|o[1-9]|text-|ft:)/i,
    models: [
      // Measured on this panel: 2 s for nano, 7 s for mini, a two-service spec with
      // declared secrets in both cases.
      { id: 'gpt-4.1-nano', price: [0.1, 0.4], tier: 'economique' },
      { id: 'gpt-4.1-mini', price: [0.4, 1.6], tier: 'equilibre' },
      { id: 'gpt-4.1', price: [2, 8], tier: 'capable' },
    ],
  },
  anthropic: {
    key: 'anthropic',
    label: 'Anthropic',
    defaultModel: 'claude-sonnet-4-5',
    modelHint: 'ex. claude-sonnet-4-5, claude-opus-4-5',
    envApiKeyVar: 'ANTHROPIC_API_KEY',
    envModelVar: 'ANTHROPIC_MODEL',
    supportsBaseUrl: false,
    nativeModel: /^claude-/i,
    models: [
      { id: 'claude-haiku-4-5', price: [1, 5], tier: 'economique' },
      { id: 'claude-sonnet-5', price: [3, 15], tier: 'equilibre' },
      { id: 'claude-opus-5', price: [5, 25], tier: 'capable' },
    ],
  },
} as const satisfies Record<string, AiProviderDescriptor>;

export type AiProvider = keyof typeof CATALOG;

/**
 * Derived from the catalog, never copied: a list written by hand would end up
 * diverging from the registry it claims to describe.
 */
export const AI_PROVIDERS = Object.keys(CATALOG) as AiProvider[];

export function isAiProvider(value: unknown): value is AiProvider {
  return typeof value === 'string' && Object.hasOwn(CATALOG, value);
}

export function aiProviderDescriptor(provider: AiProvider): AiProviderDescriptor {
  return CATALOG[provider];
}

export function aiProviderDescriptors(): AiProviderDescriptor[] {
  return AI_PROVIDERS.map((key) => CATALOG[key]);
}

/** Models suggested for this provider. Free input stays possible. */
export function aiModelOptions(provider: AiProvider): readonly AiModelOption[] {
  return CATALOG[provider].models;
}

const tierLabelsFr = {
  economique: 'économique',
  equilibre: 'équilibré',
  capable: 'le plus capable',
} as const satisfies Record<AiModelOption['tier'], string>;

const tierLabelsEn: Translated<typeof tierLabelsFr> = {
  economique: 'budget',
  equilibre: 'balanced',
  capable: 'most capable',
};

/**
 * A model's tier, as written in the dropdown list.
 *
 * It is a **dictionary** and no longer a table of sentences: the screen renders
 * it with `translator(AI_MODEL_TIER_LABELS, language)`, like the permission
 * descriptions. The keys (`economique`…) stay the data, they do not move.
 */
export const AI_MODEL_TIER_LABELS = { fr: tierLabelsFr, en: tierLabelsEn };

/**
 * The example of the expected shape, per provider.
 *
 * A dictionary next to the catalog rather than a bilingual field inside it: the
 * catalog is read by code that has no language at hand — the integration
 * checks, among others — and a two-column table instead of a string would break
 * everything that treated it as text. The `fr` column reproduces
 * `CATALOG[provider].modelHint` exactly; `@pupitre/core`'s parity test makes
 * sure both columns stay paired.
 */
const modelHintsFr = {
  openrouter: 'fournisseur/modèle, ex. anthropic/claude-sonnet-4.5',
  openai: 'ex. gpt-4.1-mini, gpt-4.1',
  anthropic: 'ex. claude-sonnet-4-5, claude-opus-4-5',
} as const satisfies Record<AiProvider, string>;

const modelHintsEn: Translated<typeof modelHintsFr> = {
  openrouter: 'provider/model, e.g. anthropic/claude-sonnet-4.5',
  openai: 'e.g. gpt-4.1-mini, gpt-4.1',
  anthropic: 'e.g. claude-sonnet-4-5, claude-opus-4-5',
};

export const aiModelHints = { fr: modelHintsFr, en: modelHintsEn };

/** The example of the expected shape, in the instance's language. */
export function aiModelHint(provider: AiProvider, language: UiLanguage = 'fr'): string {
  return renderMessage(aiModelHints, language, provider);
}

/** The **provider's** default model — not a global default. */
export function defaultAiModel(provider: AiProvider): string {
  return CATALOG[provider].defaultModel;
}

/**
 * The inconsistent model warning, in both languages.
 *
 * It is shown as is in an `Alert` of the "Artificial intelligence" screen and in
 * the generation screen: it is interface, not a technical trace.
 */
const mismatchFr = {
  other:
    "Le modèle « {model} » a la forme d'un identifiant {other}, pas {provider}. " +
    'Pour {provider}, attendu : {hint}.',
  alone:
    "Le modèle « {model} » n'a pas la forme d'un identifiant {provider} " +
    "(attendu : {hint}). Vérifiez-le : une erreur ici ne se voit qu'au moment de l'appel.",
} as const;

const mismatchEn: Translated<typeof mismatchFr> = {
  // No article before the provider's name: "a OpenAI" reads badly, and "an" would
  // depend on the provider added next year.
  other: 'Model “{model}” looks like an ID for {other}, not for {provider}. {provider} expects: {hint}.',
  alone:
    'Model “{model}” doesn’t look like an ID for {provider} (expected: {hint}). ' +
    'Check it — a wrong ID only shows up when the call is made.',
};

const MISMATCH_TEXT = { fr: mismatchFr, en: mismatchEn };

/**
 * Flags a model that does not look like an identifier of the chosen provider,
 * and names the provider it looks like.
 *
 * Why warn rather than refuse: switching from OpenRouter to Anthropic without
 * touching the model leaves `anthropic/claude-sonnet-4.5` in the field, which
 * produces not a configuration error but a 404 from the provider, a minute
 * later, in an unreadable 502 response. We prefer to say it right away.
 * Refusing would be wrong: a custom base URL serves the identifiers it wants,
 * and a new model comes out every month.
 */
export function aiModelMismatch(
  provider: AiProvider,
  model: string,
  options: {
    baseUrl?: string | null | undefined;
    /**
     * French by default, the source language: a caller that does not know which
     * language it speaks gets the original sentence.
     */
    language?: UiLanguage;
  } = {},
): string | null {
  const trimmed = model.trim();
  if (trimmed.length === 0) return null;

  const descriptor = CATALOG[provider];
  if (descriptor.nativeModel.test(trimmed)) return null;

  // A custom base URL makes any prediction moot: the server at the other end
  // serves the catalog it wants.
  if (options.baseUrl && options.baseUrl.trim().length > 0) return null;

  const language = options.language ?? 'fr';
  const other = aiProviderDescriptors().find(
    (candidate) => candidate.key !== provider && candidate.nativeModel.test(trimmed),
  );

  // The provider names and the entered identifier go through the sentence
  // untranslated: they are proper nouns.
  return renderMessage(MISMATCH_TEXT, language, other ? 'other' : 'alone', {
    model: trimmed,
    provider: descriptor.label,
    other: other?.label ?? '',
    hint: aiModelHint(provider, language),
  });
}
