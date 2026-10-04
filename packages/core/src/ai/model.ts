import { DEFAULT_AI_MODEL } from '../settings.js';
import {
  aiModelMismatch,
  aiProviderDescriptor,
  defaultAiModel,
  isAiProvider,
  type AiProvider,
} from './catalog.js';
import type { UiLanguage } from '../i18n.js';
import { aiSay } from './messages.js';
import { instantiateModel, type ConfiguredModel } from './providers.js';

/**
 * Resolving the AI configuration and building the model. A single function, a
 * single place where the key is read.
 *
 * The key never leaves the server: this module is imported by a Route Handler,
 * never by a client component. It appears neither in a log, nor in an audit
 * entry, nor in the HTTP response.
 *
 * `@pupitre/core` imports neither `@pupitre/db` nor `apps/web`: the effective
 * configuration (instance settings on one side, environment variables on the
 * other) is therefore **passed as an argument** to `resolveAiConfig()`, never
 * read here. That is what leaves the function usable from the panel as from the
 * worker.
 *
 * The choice of provider is tested nowhere in this file: it goes through the
 * catalog (`catalog.ts`) and the factory (`providers.ts`).
 */

/**
 * Historical default model — OpenRouter's. Kept under its original name for the
 * callers that cite it; prefer `defaultAiModel(p)`, which says *which provider*
 * we are talking about.
 */
export const DEFAULT_OPENROUTER_MODEL = DEFAULT_AI_MODEL;

export class MissingApiKeyError extends Error {
  readonly provider: AiProvider;

  constructor(provider: AiProvider = 'openrouter') {
    const descriptor = aiProviderDescriptor(provider);
    super(
      `No ${descriptor.label} API key is configured: AI AppSpec generation is disabled. ` +
        'Set it under Settings → Artificial intelligence' +
        `${descriptor.envApiKeyVar ? `, or through ${descriptor.envApiKeyVar}` : ''}.`,
    );
    this.name = 'MissingApiKeyError';
    this.provider = provider;
  }
}

/**
 * Key identifiers, in the shapes they take at the providers — including
 * **masked**. Observed, not assumed: on a refused key, OpenAI answers "Incorrect
 * API key provided: sk-abcd1234***…***wxyz", that is the key's first eight and
 * last four characters, in clear, in a message we then relay in an HTTP
 * response and in the audit log. A provider's mask is not our mask.
 */
const KEY_LIKE = /\b(?:sk|pk|rk|xai|gsk)[-_][A-Za-z0-9_*-]{6,}/gi;

/**
 * Removes from a message what looks like a key, before it reaches a response, a
 * log or an audit entry.
 *
 * Two passes: the exact key when we have it — it is the only guarantee — then
 * any string shaped like a key, which catches the versions truncated, masked or
 * reformatted by the provider.
 */
export function redactApiKey(
  text: string,
  apiKey?: string | null,
  language: UiLanguage = 'fr',
): string {
  const mask = aiSay(language)('redacted');
  const key = apiKey?.trim();
  const withoutExact = key && key.length >= 8 ? text.split(key).join(mask) : text;
  return withoutExact.replace(KEY_LIKE, mask);
}

export type ModelConfig = {
  provider?: AiProvider | undefined;
  apiKey: string | undefined;
  model?: string | undefined;
  baseUrl?: string | undefined;
};

function providerOf(config: { provider?: AiProvider | undefined }): AiProvider {
  return config.provider ?? 'openrouter';
}

/** Name of the model actually used, without opening a connection. */
export function resolveModelName(config: ModelConfig): string {
  const name = config.model?.trim();
  return name && name.length > 0 ? name : defaultAiModel(providerOf(config));
}

/**
 * Returns the model **and** the call options its provider requires.
 *
 * Both travel together on purpose: an OpenAI model without its
 * `strictJsonSchema: false` fails at the first call on a schema strict mode
 * cannot express. Separating them would leave the caller a responsibility it
 * has no way to take on — it does not know, and must not know, which provider
 * answers it.
 */
export function createModel(config: ModelConfig): ConfiguredModel {
  const provider = providerOf(config);
  if (!config.apiKey || config.apiKey.trim().length === 0) {
    throw new MissingApiKeyError(provider);
  }
  return instantiateModel(provider, resolveModelName(config), {
    apiKey: config.apiKey.trim(),
    baseUrl: config.baseUrl,
  });
}

// ─── Resolving settings / environment ────────────────────────────────────────

/**
 * The two possible origins of the AI configuration, in priority order. The
 * caller provides what it has: the panel reads `app_settings`, the worker may
 * only have its environment.
 */
export type AiConfigSources = {
  /** Settings from `app_settings.value.ai`. Absent = never configured. */
  settings?:
    | {
        enabled?: boolean | undefined;
        model?: string | undefined;
        provider?: string | undefined;
        baseUrl?: string | undefined;
      }
    | null
    | undefined;
  /** Key decrypted from `app_settings.ai_api_key_encrypted`. */
  settingsApiKey?: string | null | undefined;
  /**
   * Raw environment (`process.env`). We **only** read the variables the catalog
   * assigns to the chosen provider: `OPENROUTER_API_KEY` must never be used to
   * reach Anthropic. Passing the whole environment rather than two named fields is
   * what allows adding a provider without touching the panel's environment schema.
   */
  env?: Record<string, string | undefined> | null | undefined;
};

export type ResolvedAiConfig = {
  /** `false` if generation is turned off in the settings, or without a key. */
  enabled: boolean;
  provider: AiProvider;
  apiKey: string | undefined;
  model: string;
  baseUrl: string | undefined;
  /** Where the chosen key comes from — useful for a diagnosis, never for logging a value. */
  keySource: 'settings' | 'env' | 'none';
  modelSource: 'settings' | 'env' | 'default';
  /**
   * Readable warning when the model does not look like an identifier of the
   * provider. Not blocking, but shown and attached to call failures.
   */
  modelWarning: string | null;
};

function clean(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Merges settings and environment.
 *
 * Instance settings win when they are filled in: it is the live setting, the one
 * an operator just set from the screen. Environment variables stay the safety
 * net — a panel provisioned by `docker compose` works without anybody opening
 * the Settings screen.
 *
 * The settings' `enabled` flag turns generation off even if a key exists: it is
 * a switch, not a consequence.
 */
export function resolveAiConfig(sources: AiConfigSources): ResolvedAiConfig {
  const declared = sources.settings?.provider;
  const provider: AiProvider = isAiProvider(declared) ? declared : 'openrouter';
  const descriptor = aiProviderDescriptor(provider);
  const env = sources.env ?? {};

  const settingsKey = clean(sources.settingsApiKey);
  const envKey = descriptor.envApiKeyVar ? clean(env[descriptor.envApiKeyVar]) : undefined;
  const apiKey = settingsKey ?? envKey;
  const keySource = settingsKey ? 'settings' : envKey ? 'env' : 'none';

  const settingsModel = clean(sources.settings?.model);
  const envModel = descriptor.envModelVar ? clean(env[descriptor.envModelVar]) : undefined;
  const model = settingsModel ?? envModel ?? descriptor.defaultModel;
  const modelSource = settingsModel ? 'settings' : envModel ? 'env' : 'default';

  const baseUrl = descriptor.supportsBaseUrl ? clean(sources.settings?.baseUrl) : undefined;
  const switchedOn = sources.settings?.enabled ?? true;

  return {
    enabled: switchedOn && apiKey !== undefined,
    provider,
    apiKey,
    model,
    baseUrl,
    keySource,
    modelSource,
    modelWarning: aiModelMismatch(provider, model, { baseUrl }),
  };
}
