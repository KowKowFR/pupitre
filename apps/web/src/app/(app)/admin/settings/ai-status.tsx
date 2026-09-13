import { aiProviderDescriptor, resolveAiConfig } from '@pupitre/core/ai';
import type { AppSettings } from '@pupitre/core';
import { Badge } from '@/components/ui/badge';
import { getT } from '@/i18n/server';
import { settings as messages } from '@/i18n/messages/settings';

/**
 * L'état réel de la génération par IA, en une pastille.
 *
 * Il y a deux « activé » dans ce système et ils ne veulent pas dire la même
 * chose : `settings.ai.enabled` est un interrupteur, `resolveAiConfig().enabled`
 * est une capacité — l'interrupteur **et** une clé, venue des paramètres ou de
 * l'environnement. La pastille affichait le premier ; elle annonçait donc
 * « activée » en vert pendant que l'écran « Nouvelle application » grisait
 * l'onglet de génération, faute de clé. Deux écrans, deux réponses contraires à
 * la même question.
 *
 * Elle lit désormais exactement ce que lit `/applications/new`, par le même
 * appel. Trois états, parce qu'il y a trois situations distinctes à distinguer
 * et qu'un booléen n'en couvre que deux.
 */
export function aiReadiness(settings: AppSettings, storedApiKey: string | null) {
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
    // On nomme la variable attendue : « clé manquante » sans dire où la poser
    // renvoie l'utilisateur chercher dans quatre écrans.
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
