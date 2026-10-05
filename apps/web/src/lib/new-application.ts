import 'server-only';
import { aiModelMismatch, aiProviderDescriptor, resolveAiConfig } from '@pupitre/core/ai';
import { getAiApiKey, getAppSettings } from '@pupitre/db';
import { currentLanguage } from '@/i18n/server';
import { getEnv } from '@/lib/env';

/** What the "New application" form knows of AI generation. */
export type NewApplicationAi = {
  /** `false` when no key is configured, or AI is turned off. */
  aiEnabled: boolean;
  /** The chosen provider's label — "OpenRouter", "OpenAI", "Anthropic". */
  provider: string;
  model: string;
  /** Not null when the model does not look like an identifier of the provider. */
  modelWarning: string | null;
  /** The provider's fallback environment variable, to quote when the key is missing. */
  missingKeyVar: string | null;
};

/**
 * The generation's state, as the form shows it.
 *
 * The key does not leave the server: we only pass on to the client the fact that
 * it exists, the provider and the model's name — which are not secrets.
 * `process.env` rather than `getEnv()` for the providers' keys: which variable to
 * read belongs to the provider's descriptor, not to the panel's environment
 * schema.
 */
export async function newApplicationAi(): Promise<NewApplicationAi> {
  getEnv();
  const { settings } = await getAppSettings();
  const ai = resolveAiConfig({
    language: await currentLanguage(),
    settings: settings.ai,
    settingsApiKey: await getAiApiKey(),
    env: process.env,
  });
  const descriptor = aiProviderDescriptor(ai.provider);
  // `resolveAiConfig()` composes its warning without knowing whom it speaks to — it
  // also serves the worker and the logs. We compute it again here, in the
  // instance's language, because this one shows in an `Alert`.
  const modelWarning = aiModelMismatch(ai.provider, ai.model, {
    baseUrl: ai.baseUrl,
    language: await currentLanguage(),
  });
  return {
    aiEnabled: ai.enabled,
    provider: descriptor.label,
    model: ai.model,
    modelWarning,
    missingKeyVar: descriptor.envApiKeyVar,
  };
}
