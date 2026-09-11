import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { JSONValue, LanguageModel } from 'ai';
import { aiProviderDescriptor, type AiProvider } from './catalog.js';

/**
 * Fabrique de fournisseurs d'IA.
 *
 * Même forme que `getDriver()` et `getScanner()` : un registre indexé par la
 * clé, une implémentation par fournisseur, et **aucun** `if (provider === …)`
 * ailleurs dans le projet. Ajouter un fournisseur, c'est ajouter une entrée
 * ici et son descripteur dans `catalog.ts` ; rien d'autre ne bouge.
 *
 * Le type `Record<AiProvider, …>` est la garantie : un fournisseur déclaré au
 * catalogue sans fabrique ne compile pas.
 *
 * ── Le mode strict des sorties structurées ───────────────────────────────────
 * Ce que la fabrique porte n'est pas seulement « comment instancier », c'est
 * aussi « ce que ce fournisseur sait avaler ». Cas réel, remonté par un
 * utilisateur avec une vraie clé OpenAI :
 *
 *   Invalid schema for response_format 'AppSpec': In context=('properties',
 *   'services', 'items', 'properties', 'source'), 'oneOf' is not permitted.
 *
 * L'AppSpec décrit `source` par un `z.discriminatedUnion`, que Zod traduit en
 * `oneOf`. Le mode strict d'OpenAI n'accepte que `anyOf` — et exige en plus
 * `additionalProperties: false` partout, toutes les propriétés dans `required`,
 * et refuse `default`, `minimum`, `maximum`, dont l'AppSpec est pleine.
 *
 * Deux voies : appauvrir l'AppSpec pour la faire entrer dans le moule d'un
 * fournisseur — c'est-à-dire maintenir un schéma parallèle à reconstruire à
 * chaque évolution — ou désactiver le mode strict. On désactive. Ce qu'on perd
 * est une garantie dont ce code ne dépend pas : `generateAppSpec()` valide
 * déjà la réponse avec Zod et relance sur erreur. C'est le dispositif de la
 * règle 4 de CLAUDE.md — le modèle produit du JSON, **notre code le valide**.
 * La validation côté fournisseur était une ceinture en plus, pas la ceinture.
 *
 * Et puisque c'est une propriété du fournisseur, elle est déclarée ici, dans sa
 * fabrique — pas dans `generate.ts`, qui ne doit rien savoir de qui répond.
 * Chaque fournisseur l'exprime d'ailleurs à sa façon : OpenAI par une option
 * d'appel, OpenRouter par un réglage de modèle, Anthropic pas du tout (il passe
 * par l'appel d'outil, dont le schéma n'est pas soumis au même moule).
 */

export type ProviderCredentials = {
  apiKey: string;
  /** Seulement pour les fournisseurs qui l'acceptent (cf. `supportsBaseUrl`). */
  baseUrl?: string | undefined;
};

/**
 * Options d'appel propres au fournisseur, indexées par son identifiant dans le
 * SDK. `generateObject` les transmet telles quelles et ignore celles qui ne
 * concernent pas le modèle utilisé : l'appelant n'a donc jamais à savoir
 * lesquelles s'appliquent.
 */
export type ProviderCallOptions = Record<string, Record<string, JSONValue>>;

/** Un modèle prêt à l'emploi, et ce qu'il faut passer à l'appel pour lui. */
export type ConfiguredModel = {
  model: LanguageModel;
  callOptions: ProviderCallOptions;
};

/** Une fabrique rend un sélecteur de modèle, pas un modèle : le nom vient après. */
export type AiProviderFactory = (
  credentials: ProviderCredentials,
) => (modelName: string) => ConfiguredModel;

const registry: Record<AiProvider, AiProviderFactory> = {
  // OpenRouter achemine vers des fournisseurs tiers, dont OpenAI : le même mur
  // se dresse selon le modèle routé. Le réglage se pose ici à la construction
  // du modèle, et non en option d'appel — c'est la forme que le paquet expose.
  openrouter: ({ apiKey }) => {
    const provider = createOpenRouter({ apiKey });
    return (modelName) => ({
      model: provider.chat(modelName, { structuredOutputs: { strict: false } }),
      callOptions: {},
    });
  },
  // `.chat()` et non l'appel direct : l'API Chat Completions est celle que
  // réimplémentent les serveurs compatibles OpenAI, donc la seule qui tienne
  // quand `baseUrl` pointe ailleurs que chez OpenAI.
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
 * Instancie le modèle d'un fournisseur. L'URL de base n'est transmise qu'aux
 * fournisseurs qui la déclarent : la donner ailleurs serait l'ignorer en
 * silence, ce qui est pire que de ne pas la proposer.
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
