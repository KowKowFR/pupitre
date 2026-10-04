import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { JSONValue, LanguageModel } from 'ai';
import { aiProviderDescriptor, type AiProvider } from './catalog.js';

/**
 * AI provider factory.
 *
 * The same shape as `getDriver()` and `getScanner()`: a registry indexed by key,
 * one implementation per provider, and **no** `if (provider === …)` elsewhere in
 * the project. Adding a provider means adding an entry here and its descriptor
 * in `catalog.ts`; nothing else moves.
 *
 * The `Record<AiProvider, …>` type is the guarantee: a provider declared in the
 * catalog without a factory does not compile.
 *
 * ── Structured outputs' strict mode ──────────────────────────────────────────
 * What the factory carries is not only "how to instantiate", it is also "what
 * this provider can swallow". A real case, reported by a user with a real OpenAI
 * key:
 *
 *   Invalid schema for response_format 'AppSpec': In context=('properties',
 *   'services', 'items', 'properties', 'source'), 'oneOf' is not permitted.
 *
 * The AppSpec describes `source` with a `z.discriminatedUnion`, which Zod
 * translates into `oneOf`. OpenAI's strict mode only accepts `anyOf` — and also
 * requires `additionalProperties: false` everywhere, every property in
 * `required`, and refuses `default`, `minimum`, `maximum`, which the AppSpec is
 * full of.
 *
 * Two ways: impoverish the AppSpec to fit it into one provider's mold — that is
 * maintain a parallel schema to rebuild at each change — or disable strict mode.
 * We disable it. What we lose is a guarantee this code does not depend on:
 * `generateAppSpec()` already validates the response with Zod and retries on
 * error. It is the mechanism of rule 4 in CLAUDE.md — the model produces JSON,
 * **our code validates it**. The provider-side validation was an extra belt, not
 * the belt.
 *
 * And since it is a property of the provider, it is declared here, in its
 * factory — not in `generate.ts`, which must know nothing about who answers.
 * Each provider expresses it its own way, by the way: OpenAI through a call
 * option, OpenRouter through a model setting, Anthropic not at all (it goes
 * through tool calling, whose schema is not subject to the same mold).
 */

export type ProviderCredentials = {
  apiKey: string;
  /** Only for the providers that accept it (see `supportsBaseUrl`). */
  baseUrl?: string | undefined;
};

/**
 * Provider-specific call options, indexed by its identifier in the SDK.
 * `generateObject` passes them on as is and ignores those that do not concern
 * the model used: the caller therefore never has to know which apply.
 */
export type ProviderCallOptions = Record<string, Record<string, JSONValue>>;

/** A ready-to-use model, and what must be passed to the call for it. */
export type ConfiguredModel = {
  model: LanguageModel;
  callOptions: ProviderCallOptions;
};

/** A factory returns a model selector, not a model: the name comes after. */
export type AiProviderFactory = (
  credentials: ProviderCredentials,
) => (modelName: string) => ConfiguredModel;

const registry: Record<AiProvider, AiProviderFactory> = {
  // OpenRouter routes to third-party providers, OpenAI among them: the same wall
  // rises depending on the routed model. The setting is set here when building
  // the model, and not as a call option — it is the shape the package exposes.
  openrouter: ({ apiKey }) => {
    const provider = createOpenRouter({ apiKey });
    return (modelName) => ({
      model: provider.chat(modelName, { structuredOutputs: { strict: false } }),
      callOptions: {},
    });
  },
  // `.chat()` and not the direct call: the Chat Completions API is the one
  // OpenAI-compatible servers reimplement, hence the only one that holds when
  // `baseUrl` points elsewhere than OpenAI.
  openai: ({ apiKey, baseUrl }) => {
    const provider = createOpenAI({
      apiKey,
      ...(baseUrl ? { baseURL: baseUrl } : {}),
    });
    return (modelName) => ({
      model: provider.chat(modelName),
      callOptions: { openai: { strictJsonSchema: false } },
    });
  },
  anthropic: ({ apiKey }) => {
    const provider = createAnthropic({ apiKey });
    return (modelName) => ({
      model: provider.languageModel(modelName),
      callOptions: {},
    });
  },
};

export function getAiProviderFactory(provider: AiProvider): AiProviderFactory {
  return registry[provider];
}

/**
 * Instantiates a provider's model. The base URL is only passed to the providers
 * that declare it: giving it elsewhere would silently ignore it, which is worse
 * than not offering it.
 */
export function instantiateModel(
  provider: AiProvider,
  modelName: string,
  credentials: ProviderCredentials,
): ConfiguredModel {
  const descriptor = aiProviderDescriptor(provider);
  return registry[provider]({
    apiKey: credentials.apiKey,
    ...(descriptor.supportsBaseUrl && credentials.baseUrl
      ? { baseUrl: credentials.baseUrl }
      : {}),
  })(modelName);
}
