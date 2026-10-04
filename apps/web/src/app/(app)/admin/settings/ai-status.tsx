import { aiProviderDescriptor, resolveAiConfig } from '@pupitre/core/ai';
import type { AppSettings } from '@pupitre/core';
import { Badge } from '@/components/ui/badge';
import { getT } from '@/i18n/server';
import { settings as messages } from '@/i18n/messages/settings';

/**
 * The real state of AI generation, in one chip.
 *
 * There are two "enabled" in this system and they do not mean the same thing:
 * `settings.ai.enabled` is a switch, `resolveAiConfig().enabled` is a capability
 * — the switch **and** a key, from the settings or from the environment. The
 * chip used to show the former; it therefore announced "enabled" in green while
 * the "New application" screen greyed out the generation tab, for lack of a key.
 * Two screens, two opposite answers to the same question.
 *
 * It now reads exactly what "New application" reads, through the same call.
 * Three states, because there are three distinct situations to tell apart and a
 * boolean only covers two.
 */
function aiReadiness(settings: AppSettings, storedApiKey: string | null) {
  return resolveAiConfig({
    settings: settings.ai,
    settingsApiKey: storedApiKey ?? undefined,
    env: process.env,
  });
}

export async function AiStatusBadge({
  settings,
  storedApiKey,
}: {
  settings: AppSettings;
  storedApiKey: string | null;
}) {
  const config = aiReadiness(settings, storedApiKey);
  const t = await getT(messages);

  if (!settings.ai.enabled) {
    return <Badge variant="secondary">{t('ai.badge.off')}</Badge>;
  }
  if (!config.enabled) {
    // We name the expected variable: "missing key" without saying where to put it
    // sends the user looking through four screens.
    const envVar = aiProviderDescriptor(config.provider).envApiKeyVar;
    return (
      <Badge
        variant="warn"
        title={envVar ? t('ai.badge.missingKey.title', { envVar }) : undefined}
      >
        {t('ai.badge.missingKey')}
      </Badge>
    );
  }
  return <Badge variant="ok">{t('ai.badge.on')}</Badge>;
}
