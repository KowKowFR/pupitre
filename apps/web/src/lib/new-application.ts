import 'server-only';
import { aiModelMismatch, aiProviderDescriptor, resolveAiConfig } from '@pupitre/core/ai';
import { getAiApiKey, getAppSettings } from '@pupitre/db';
import { currentLanguage } from '@/i18n/server';
import { getEnv } from '@/lib/env';

/** Ce que le formulaire « Nouvelle application » sait de la génération par IA. */
export type NewApplicationAi = {
  /** `false` quand aucune clé n'est configurée, ou que l'IA est coupée. */
  aiEnabled: boolean;
  /** Libellé du fournisseur retenu — « OpenRouter », « OpenAI », « Anthropic ». */
  provider: string;
  model: string;
  /** Non nul quand le modèle ne ressemble pas à un identifiant du fournisseur. */
  modelWarning: string | null;
  /** Variable d'environnement de repli du fournisseur, à citer quand la clé manque. */
  missingKeyVar: string | null;
};

/**
 * L'état de la génération, tel que le formulaire le montre.
 *
 * La clé ne quitte pas le serveur : on ne transmet au client que le fait
 * qu'elle existe, le fournisseur et le nom du modèle — qui ne sont pas des
 * secrets. `process.env` plutôt que `getEnv()` pour les clés de fournisseurs :
 * quelle variable lire appartient au descripteur du fournisseur, pas au
 * schéma d'environnement du panel.
 */
export async function newApplicationAi(): Promise<NewApplicationAi> {
  getEnv();
  const { settings } = await getAppSettings();
  const ai = resolveAiConfig({
    settings: settings.ai,
    settingsApiKey: await getAiApiKey(),
    env: process.env,
  });
  const descriptor = aiProviderDescriptor(ai.provider);
  // `resolveAiConfig()` compose son avertissement sans savoir à qui il parle —
  // il sert aussi le worker et les logs. On le recalcule ici, dans la langue de
  // l'instance, parce que celui-là s'affiche dans une `Alert`.
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
