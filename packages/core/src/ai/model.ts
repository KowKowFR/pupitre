import { DEFAULT_AI_MODEL } from '../settings.js';
import {
  aiModelMismatch,
  aiProviderDescriptor,
  defaultAiModel,
  isAiProvider,
  type AiProvider,
} from './catalog.js';
import { instantiateModel, type ConfiguredModel } from './providers.js';

/**
 * Résolution de la configuration IA et fabrique du modèle. Une seule fonction,
 * un seul endroit où la clé est lue.
 *
 * La clé ne quitte jamais le serveur : ce module est importé par un Route
 * Handler, jamais par un composant client. Elle n'apparaît ni dans un log, ni
 * dans une entrée d'audit, ni dans la réponse HTTP.
 *
 * `@pupitre/core` n'importe ni `@pupitre/db` ni `apps/web` : la configuration effective
 * (paramètres d'instance d'un côté, variables d'environnement de l'autre) est
 * donc **passée en argument** à `resolveAiConfig()`, jamais lue ici. C'est ce
 * qui laisse la fonction utilisable depuis le panel comme depuis le worker.
 *
 * Le choix du fournisseur ne se teste nulle part dans ce fichier : il traverse
 * le catalogue (`catalog.ts`) et la fabrique (`providers.ts`).
 */

/**
 * Modèle par défaut historique — celui d'OpenRouter. Conservé sous son nom
 * d'origine pour les appelants qui le citent ; préférez `defaultAiModel(p)`,
 * qui dit *de quel fournisseur* on parle.
 */
export const DEFAULT_OPENROUTER_MODEL = DEFAULT_AI_MODEL;

export class MissingApiKeyError extends Error {
  readonly provider: AiProvider;

  constructor(provider: AiProvider = 'openrouter') {
    const descriptor = aiProviderDescriptor(provider);
    super(
      `Aucune clé d'API ${descriptor.label} n'est configurée : la génération d'AppSpec ` +
        'par IA est désactivée. Renseignez-la dans Paramètres → Intelligence ' +
        `artificielle${descriptor.envApiKeyVar ? `, ou via ${descriptor.envApiKeyVar}` : ''}.`,
    );
    this.name = 'MissingApiKeyError';
    this.provider = provider;
  }
}

/**
 * Identifiants de clé, dans les formes qu'ils prennent chez les fournisseurs —
 * y compris **masqués**. Constaté, pas supposé : sur une clé refusée, OpenAI
 * répond « Incorrect API key provided: sk-abcd1234***…***wxyz », soit les huit
 * premiers et les quatre derniers caractères de la clé, en clair, dans un
 * message que nous relayons ensuite dans une réponse HTTP et dans le journal
 * d'audit. Un masque du fournisseur n'est pas notre masque.
 */
const KEY_LIKE = /\b(?:sk|pk|rk|xai|gsk)[-_][A-Za-z0-9_*-]{6,}/gi;

/**
 * Retire d'un message ce qui ressemble à une clé, avant qu'il n'atteigne une
 * réponse, un log ou une entrée d'audit.
 *
 * Deux passes : la clé exacte quand on l'a — c'est la seule garantie — puis
 * toute chaîne qui a la forme d'une clé, ce qui rattrape les versions
 * tronquées, masquées ou reformatées par le fournisseur.
 */
export function redactApiKey(text: string, apiKey?: string | null): string {
  const key = apiKey?.trim();
  const withoutExact =
    key && key.length >= 8 ? text.split(key).join('[clé masquée]') : text;
  return withoutExact.replace(KEY_LIKE, '[clé masquée]');
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

/** Nom du modèle effectivement utilisé, sans ouvrir de connexion. */
export function resolveModelName(config: ModelConfig): string {
  const name = config.model?.trim();
  return name && name.length > 0 ? name : defaultAiModel(providerOf(config));
}

/**
 * Rend le modèle **et** les options d'appel que son fournisseur exige.
 *
 * Les deux voyagent ensemble à dessein : un modèle OpenAI sans son
 * `strictJsonSchema: false` échoue au premier appel sur un schéma que le mode
 * strict ne sait pas exprimer. Les séparer laisserait à l'appelant une
 * responsabilité qu'il n'a aucun moyen d'assumer — il ne sait pas, et ne doit
 * pas savoir, quel fournisseur lui répond.
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

// ─── Résolution paramètres / environnement ───────────────────────────────────

/**
 * Les deux origines possibles de la configuration IA, dans l'ordre de priorité.
 * L'appelant fournit ce qu'il a : le panel lit `app_settings`, le worker peut
 * n'avoir que son environnement.
 */
export type AiConfigSources = {
  /** Réglages issus de `app_settings.value.ai`. Absents = jamais configurés. */
  settings?:
    | {
        enabled?: boolean | undefined;
        model?: string | undefined;
        provider?: string | undefined;
        baseUrl?: string | undefined;
      }
    | null
    | undefined;
  /** Clé déchiffrée depuis `app_settings.ai_api_key_encrypted`. */
  settingsApiKey?: string | null | undefined;
  /**
   * Environnement brut (`process.env`). On n'y lit **que** les variables que le
   * catalogue attribue au fournisseur retenu : `OPENROUTER_API_KEY` ne doit
   * jamais servir à joindre Anthropic. Passer l'environnement entier plutôt que
   * deux champs nommés est ce qui permet d'ajouter un fournisseur sans toucher
   * au schéma d'environnement du panel.
   */
  env?: Record<string, string | undefined> | null | undefined;
};

export type ResolvedAiConfig = {
  /** `false` si la génération est coupée dans les paramètres, ou sans clé. */
  enabled: boolean;
  provider: AiProvider;
  apiKey: string | undefined;
  model: string;
  baseUrl: string | undefined;
  /** D'où vient la clé retenue — utile pour un diagnostic, jamais pour un log de valeur. */
  keySource: 'settings' | 'env' | 'none';
  modelSource: 'settings' | 'env' | 'default';
  /**
   * Avertissement lisible quand le modèle ne ressemble pas à un identifiant du
   * fournisseur. Non bloquant, mais affiché et joint aux échecs d'appel.
   */
  modelWarning: string | null;
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
