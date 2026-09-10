import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModel } from 'ai';
import { DEFAULT_AI_MODEL } from '../settings.js';

/**
 * Fabrique du modèle. Une seule fonction, un seul endroit où la clé est lue.
 *
 * La clé ne quitte jamais le serveur : ce module est importé par un Route
 * Handler, jamais par un composant client. Elle n'apparaît ni dans un log, ni
 * dans une entrée d'audit, ni dans la réponse HTTP.
 *
 * `@tp/core` n'importe ni `@tp/db` ni `apps/web` : la configuration effective
 * (paramètres d'instance d'un côté, variables d'environnement de l'autre) est
 * donc **passée en argument** à `resolveAiConfig()`, jamais lue ici. C'est ce
 * qui laisse la fonction utilisable depuis le panel comme depuis le worker.
 */

/**
 * Modèle par défaut. Défini dans `../settings.js` — la racine de `@tp/core`
 * doit pouvoir le connaître sans tirer le SDK IA dans son graphe.
 */
export const DEFAULT_OPENROUTER_MODEL = DEFAULT_AI_MODEL;

export class MissingApiKeyError extends Error {
  constructor() {
    super(
      "Aucune clé d'API n'est configurée : la génération d'AppSpec par IA est désactivée. " +
        'Renseignez-la dans Paramètres → Intelligence artificielle, ou via OPENROUTER_API_KEY.',
    );
    this.name = 'MissingApiKeyError';
  }
}

export type ModelConfig = {
  apiKey: string | undefined;
  model?: string | undefined;
};

/** Nom du modèle effectivement utilisé, sans ouvrir de connexion. */
export function resolveModelName(config: ModelConfig): string {
  const name = config.model?.trim();
  return name && name.length > 0 ? name : DEFAULT_OPENROUTER_MODEL;
}

export function createModel(config: ModelConfig): LanguageModel {
  if (!config.apiKey || config.apiKey.trim().length === 0) {
    throw new MissingApiKeyError();
  }
  const openrouter = createOpenRouter({ apiKey: config.apiKey });
  return openrouter.chat(resolveModelName(config));
}

// ─── Résolution paramètres / environnement ───────────────────────────────────

/**
 * Les deux origines possibles de la configuration IA, dans l'ordre de priorité.
 * L'appelant fournit ce qu'il a : le panel lit `app_settings`, le worker peut
 * n'avoir que son environnement.
 */
export type AiConfigSources = {
  /** Réglages issus de `app_settings.value.ai`. Absents = jamais configurés. */
  settings?: { enabled?: boolean; model?: string } | null | undefined;
  /** Clé déchiffrée depuis `app_settings.ai_api_key_encrypted`. */
  settingsApiKey?: string | null | undefined;
  envApiKey?: string | null | undefined;
  envModel?: string | null | undefined;
};

export type ResolvedAiConfig = {
  /** `false` si la génération est coupée dans les paramètres, ou sans clé. */
  enabled: boolean;
  apiKey: string | undefined;
  model: string;
  /** D'où vient la clé retenue — utile pour un diagnostic, jamais pour un log de valeur. */
  keySource: 'settings' | 'env' | 'none';
  modelSource: 'settings' | 'env' | 'default';
};

function clean(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Fusionne paramètres et environnement.
 *
 * Les paramètres d'instance gagnent quand ils sont renseignés : c'est le
 * réglage à chaud, celui qu'un opérateur vient de poser depuis l'écran. Les
 * variables d'environnement restent le filet — un panel provisionné par
 * `docker compose` fonctionne sans que personne n'ouvre l'écran Paramètres.
 *
 * Le drapeau `enabled` des paramètres coupe la génération même si une clé
 * existe : c'est un interrupteur, pas une conséquence.
 */
export function resolveAiConfig(sources: AiConfigSources): ResolvedAiConfig {
  const settingsKey = clean(sources.settingsApiKey);
  const envKey = clean(sources.envApiKey);
  const apiKey = settingsKey ?? envKey;
  const keySource = settingsKey ? 'settings' : envKey ? 'env' : 'none';

  const settingsModel = clean(sources.settings?.model);
  const envModel = clean(sources.envModel);
  const model = settingsModel ?? envModel ?? DEFAULT_OPENROUTER_MODEL;
  const modelSource = settingsModel ? 'settings' : envModel ? 'env' : 'default';

  const switchedOn = sources.settings?.enabled ?? true;

  return {
    enabled: switchedOn && apiKey !== undefined,
    apiKey,
    model,
    keySource,
    modelSource,
  };
}
