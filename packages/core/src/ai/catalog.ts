/**
 * Catalogue des fournisseurs d'IA — la partie *données* de l'abstraction.
 *
 * Même découpage que `Scanner` et `DeploymentDriver` : d'un côté une
 * description déclarative (ici), de l'autre une fabrique qui instancie
 * (`./providers.js`). La séparation n'est pas cosmétique — ce module ne dépend
 * de **rien**, ce qui permet à `settings.ts`, donc à `@pupitre/db` et au worker, de
 * connaître la liste des fournisseurs sans tirer le SDK IA dans leur graphe.
 *
 * Ajouter un quatrième fournisseur = une entrée ici, une entrée dans la
 * fabrique. Ni les routes, ni l'UI, ni le schéma de paramètres, ni le schéma
 * d'environnement du panel n'ont à changer : tout ce qui varie d'un fournisseur
 * à l'autre — identifiant de modèle par défaut, variable d'environnement de
 * repli, forme des identifiants — est décrit ici, jamais testé par un `if`.
 */

import { renderMessage, type Translated, type UiLanguage } from '../i18n.js';

/**
 * Un modèle proposé dans la liste déroulante.
 *
 * Une suggestion, pas une contrainte : le champ reste libre. Les catalogues
 * bougent toutes les semaines, et figer une énumération dans le code
 * empêcherait d'utiliser un modèle sorti après la dernière mise à jour du
 * panel — exactement le genre de blocage qu'on ne veut pas s'infliger.
 */
export type AiModelOption = {
  readonly id: string;
  /**
   * Prix indicatif en dollars par million de jetons, **entrée puis sortie**.
   *
   * Deux nombres et non une chaîne toute faite : « 0,10 / 0,40 » est un
   * format, pas une donnée, et l'instance anglaise écrit « 0.10 / 0.40 ». Le
   * catalogue porte les valeurs, l'écran porte la virgule.
   *
   * Relevé le 2026-09-11 ; il vieillira. Affiché comme un ordre de grandeur
   * pour choisir, jamais comme une facture — l'écran le dit.
   */
  readonly price: readonly [input: number, output: number];
  readonly tier: 'economique' | 'equilibre' | 'capable';
};

export type AiProviderDescriptor = {
  /** Clé stockée dans `app_settings.value.ai.provider`. */
  readonly key: string;
  readonly label: string;
  /**
   * Modèle retenu quand personne n'en a choisi un. Chaque fournisseur a sa
   * propre convention d'identifiant : `anthropic/claude-sonnet-4.5` chez
   * OpenRouter, `claude-sonnet-4-5` chez Anthropic, `gpt-5.2` chez OpenAI.
   */
  readonly defaultModel: string;
  /**
   * Exemple affiché sous le champ « Modèle », pour dire la forme attendue.
   *
   * **Dans la langue source.** L'identifiant montré ne se traduit pas, mais
   * « ex. » et « fournisseur/modèle » sont de la prose : l'écran passe donc par
   * `aiModelHint(provider, language)`, qui lit le dictionnaire
   * `aiModelHints`. Ce champ-ci reste une chaîne, comme `Error.message` reste
   * français — c'est ce que lisent les outils et les vérifications qui
   * inspectent le catalogue sans avoir de langue à leur disposition.
   */
  readonly modelHint: string;
  /**
   * Variable d'environnement de repli, **propre au fournisseur**.
   * `OPENROUTER_API_KEY` ne vaut que pour OpenRouter : la lire pour Anthropic
   * enverrait une clé à la mauvaise API, et l'échec serait incompréhensible.
   */
  readonly envApiKeyVar: string | null;
  readonly envModelVar: string | null;
  /**
   * URL de base personnalisable. Vraie pour les API compatibles OpenAI
   * (vLLM, LiteLLM, Ollama, une passerelle interne), fausse sinon.
   */
  readonly supportsBaseUrl: boolean;
  /**
   * Reconnaît un identifiant de modèle **natif** du fournisseur. Sert à
   * prévenir — jamais à interdire : une URL de base personnalisée peut servir
   * n'importe quel identifiant.
   */
  readonly nativeModel: RegExp;
  /**
   * Quelques modèles éprouvés, du moins cher au plus capable.
   *
   * Générer une AppSpec demande de tenir un JSON structuré sur plusieurs
   * services : les modèles minuscules à deux centimes du million y échouent,
   * et « pas cher » ne vaut rien si la réponse est inexploitable. Les entrées
   * ci-dessous sont le compromis retenu, pas le bas du catalogue.
   *
   * Les modèles **à raisonnement** (famille `gpt-5`, `o*`) en sont volontairement
   * absents : mesurés ici, ils dépassent la borne de la route de génération. Un
   * modèle recommandé qui expire n'est pas une recommandation. Rien n'empêche
   * de les saisir à la main si la borne est relevée un jour.
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
    // OpenRouter préfixe systématiquement par l'éditeur du modèle.
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
    // Seul fournisseur à accepter une URL de base : c'est son protocole que les
    // serveurs auto-hébergés réimplémentent.
    supportsBaseUrl: true,
    nativeModel: /^(gpt-|chatgpt-|o[1-9]|text-|ft:)/i,
    models: [
      // Mesurés sur ce panel : 2 s pour le nano, 7 s pour le mini, spec en deux
      // services et secrets déclarés dans les deux cas.
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
 * Dérivée du catalogue, jamais recopiée : une liste écrite à la main finirait
 * par diverger du registre qu'elle prétend décrire.
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

/** Modèles suggérés pour ce fournisseur. La saisie libre reste possible. */
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
 * Le cran d'un modèle, tel qu'il s'écrit dans la liste déroulante.
 *
 * C'est un **dictionnaire** et non plus une table de phrases : l'écran le rend
 * avec `translator(AI_MODEL_TIER_LABELS, language)`, comme les descriptions de
 * permissions. Les clés (`economique`…) restent la donnée, elles ne bougent pas.
 */
export const AI_MODEL_TIER_LABELS = { fr: tierLabelsFr, en: tierLabelsEn };

/**
 * L'exemple de forme attendue, par fournisseur.
 *
 * Un dictionnaire à côté du catalogue plutôt qu'un champ bilingue dedans : le
 * catalogue est lu par du code qui n'a pas de langue sous la main — les
 * vérifications d'intégration, entre autres — et une table de deux colonnes à
 * la place d'une chaîne y casse tout ce qui la traitait comme du texte. La
 * colonne `fr` reproduit `CATALOG[provider].modelHint` à l'identique ; le test
 * de parité de `@pupitre/core` s'assure que les deux colonnes restent
 * appariées.
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

/** L'exemple de forme attendue, dans la langue de l'instance. */
export function aiModelHint(provider: AiProvider, language: UiLanguage = 'fr'): string {
  return renderMessage(aiModelHints, language, provider);
}

/** Modèle par défaut **du fournisseur** — pas un défaut global. */
export function defaultAiModel(provider: AiProvider): string {
  return CATALOG[provider].defaultModel;
}

/**
 * L'avertissement de modèle incohérent, dans les deux langues.
 *
 * Il s'affiche tel quel dans une `Alert` de l'écran « Intelligence
 * artificielle » et dans l'écran de génération : c'est de l'interface, pas une
 * trace technique.
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
  // Pas d'article devant le nom du fournisseur : « a OpenAI » se lit mal, et
  // « an » dépendrait du fournisseur qu'on ajoutera l'an prochain.
  other: 'Model “{model}” looks like an ID for {other}, not for {provider}. {provider} expects: {hint}.',
  alone:
    'Model “{model}” doesn’t look like an ID for {provider} (expected: {hint}). ' +
    'Check it — a wrong ID only shows up when the call is made.',
};

const MISMATCH_TEXT = { fr: mismatchFr, en: mismatchEn };

/**
 * Signale un modèle qui ne ressemble pas à un identifiant du fournisseur
 * retenu, et nomme le fournisseur auquel il ressemble.
 *
 * Pourquoi prévenir plutôt que refuser : passer d'OpenRouter à Anthropic sans
 * toucher au modèle laisse `anthropic/claude-sonnet-4.5` dans le champ, ce qui
 * ne produit pas une erreur de configuration mais un 404 du fournisseur, une
 * minute plus tard, dans une réponse 502 illisible. On préfère le dire tout de
 * suite. Refuser serait faux : une URL de base personnalisée sert les
 * identifiants qu'elle veut, et un nouveau modèle sort chaque mois.
 */
export function aiModelMismatch(
  provider: AiProvider,
  model: string,
  options: {
    baseUrl?: string | null | undefined;
    /** Défaut au français, la langue source : un appelant qui ne sait pas
     *  dans quelle langue il parle obtient la phrase d'origine. */
    language?: UiLanguage;
  } = {},
): string | null {
  const trimmed = model.trim();
  if (trimmed.length === 0) return null;

  const descriptor = CATALOG[provider];
  if (descriptor.nativeModel.test(trimmed)) return null;

  // Une URL de base personnalisée rend toute prédiction caduque : le serveur au
  // bout sert le catalogue qu'il veut.
  if (options.baseUrl && options.baseUrl.trim().length > 0) return null;

  const language = options.language ?? 'fr';
  const other = aiProviderDescriptors().find(
    (candidate) => candidate.key !== provider && candidate.nativeModel.test(trimmed),
  );

  // Les noms de fournisseurs et l'identifiant saisi traversent la phrase sans
  // être traduits : ce sont des noms propres.
  return renderMessage(MISMATCH_TEXT, language, other ? 'other' : 'alone', {
    model: trimmed,
    provider: descriptor.label,
    other: other?.label ?? '',
    hint: aiModelHint(provider, language),
  });
}
