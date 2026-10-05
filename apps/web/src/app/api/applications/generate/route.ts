import {
  DEFAULT_TIMEOUT_MS,
  MissingApiKeyError,
  aiModelMismatch,
  aiProviderDescriptor,
  createModel,
  redactApiKey,
  generateAppSpec,
  generateAppSpecInputSchema,
  resolveAiConfig,
} from '@pupitre/core/ai';
import { renderMessage } from '@pupitre/core';
import { getAiApiKey, getApplicationBySlug, getAppSettings, logAudit } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { applications as messages } from '@/i18n/messages/applications';
import { currentLanguage } from '@/i18n/server';
import { HttpError, NotImplementedError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { getEnv } from '@/lib/env';
import { logger } from '@/lib/logger';
import { APPSPEC_GENERATION_RULE, enforceRateLimit } from '@/lib/rate-limit';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Le fournisseur a 60 s ; la route s'accorde un peu plus pour rendre l'échec. */
export const maxDuration = 90;

/**
 * Génération d'une AppSpec à partir d'une description.
 *
 * Ce que cette route ne fait PAS, et c'est délibéré : elle **ne persiste rien**
 * et **ne déploie rien**. Elle rend une AppSpec, que l'utilisateur relit,
 * corrige dans l'éditeur, puis soumet à `POST /api/applications` comme
 * n'importe quelle autre. Une IA qui écrirait directement en base retirerait à
 * l'opérateur le seul moment où il peut dire non.
 *
 * Elle reste synchrone, à rebours de la règle « toute opération longue passe par
 * BullMQ » : ce n'est pas une opération d'infrastructure, rien ne survit à
 * l'appel, et personne n'a besoin de la reprendre après un redémarrage. Ce qui
 * justifie la queue — reprise, journal d'étapes, exécution distante — est ici
 * sans objet. Le garde-fou est ailleurs : un timeout, une limite de débit et
 * une taille de prompt bornée.
 *
 * C'est le même arbitrage que `GET /api/targets/[id]/metrics`, tranché pour les
 * mêmes raisons : un relevé borné, sans effet de bord, dont le résultat meurt
 * avec la réponse, n'a rien à faire dans une queue. Passer par BullMQ coûterait
 * ici un job, une table d'état et un canal de suivi pour rendre au client
 * exactement ce qu'un appel de soixante secondes lui rend déjà — et rendrait
 * *plus* difficile le seul cas qui compte, l'abandon par l'opérateur.
 */

export const POST = apiRoute(async (request) => {
  const auth = await requirePermission(request, 'application:create');

  // Le corps est validé AVANT de regarder la configuration : une requête mal
  // formée est mal formée sur tous les panels, avec ou sans clé. L'inverse
  // rendrait la réponse dépendante du déploiement — un client ne pourrait plus
  // distinguer « ma requête est fausse » de « ce panel n'a pas d'IA ».
  const input = await readJsonBody(request, generateAppSpecInputSchema);

  // Les paramètres d'instance priment sur l'environnement : c'est le réglage
  // qu'un opérateur vient de poser depuis l'écran Paramètres. L'environnement
  // reste le filet pour un panel provisionné sans que personne l'ouvre.
  // `getEnv()` valide la configuration du panel ; les clés des fournisseurs d'IA
  // ne sont pas dans son schéma, et c'est délibéré : quelle variable lire est
  // une propriété du fournisseur, décrite dans son descripteur. Ajouter un
  // quatrième fournisseur ne doit pas obliger à toucher `env.ts`.
  getEnv();
  const { settings } = await getAppSettings();
  const ai = resolveAiConfig({
    settings: settings.ai,
    settingsApiKey: await getAiApiKey(),
    env: process.env,
  });

  const providerLabel = aiProviderDescriptor(ai.provider).label;
  // Le même avertissement que celui de `resolveAiConfig()`, mais rendu dans la
  // langue de l'instance : celui-ci finit dans un message d'erreur lu à l'écran.
  const uiLanguage = await currentLanguage();
  const modelWarning = aiModelMismatch(ai.provider, ai.model, {
    baseUrl: ai.baseUrl,
    language: uiLanguage,
  });

  // Le renvoi vers la variable d'environnement s'insère DANS la phrase :
  // il ne peut pas attendre la sérialisation, la clé qui le porte, si.
  const descriptor = aiProviderDescriptor(ai.provider);
  const noKey = () =>
    new NotImplementedError(
      msg(messages, 'error.aiNoKey', {
        provider: providerLabel,
        envVar: descriptor.envApiKeyVar
          ? renderMessage(messages, uiLanguage, 'error.aiEnvVar', {
              variable: descriptor.envApiKeyVar,
            })
          : '',
      }),
    );

  if (!ai.enabled) {
    throw settings.ai.enabled
      ? noKey()
      : new NotImplementedError(msg(messages, 'error.aiDisabled'));
  }

  const modelName = ai.model;

  // Un modèle qui n'a pas la forme d'un identifiant du fournisseur ne produit
  // pas une erreur de configuration mais un 404 du fournisseur, une minute plus
  // tard. On le dit ici, avant l'appel, et on le rappelle si l'appel échoue.
  if (ai.modelWarning) {
    logger.warn(
      { provider: ai.provider, model: ai.model },
      'modèle IA incohérent avec le fournisseur configuré',
    );
  }

  // Par utilisateur : la route coûte de l'argent, et la session est obligatoire.
  await enforceRateLimit(APPSPEC_GENERATION_RULE, auth.userId);

  // Le modèle vient avec les options que son fournisseur exige — le mode strict
  // des sorties structurées, notamment, qu'OpenAI refuse d'appliquer à un
  // schéma portant un `oneOf`. La route ne les interprète pas : elle les relaie.
  let configured;
  try {
    configured = createModel({
      provider: ai.provider,
      apiKey: ai.apiKey,
      model: ai.model,
      baseUrl: ai.baseUrl,
    });
  } catch (error) {
    if (error instanceof MissingApiKeyError) throw noKey();
    throw error;
  }

  const result = await generateAppSpec({
    model: configured.model,
    providerOptions: configured.callOptions,
    modelName,
    input,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    temperature: settings.ai.temperature,
    maxOutputTokens: settings.ai.maxTokens,
    language: uiLanguage,
  });

  // Le message d'un fournisseur n'est pas un texte de confiance : OpenAI y
  // recopie la clé refusée, partiellement masquée — donc partiellement en
  // clair. Il est nettoyé ici, une fois, avant l'audit ET avant la réponse.
  const failureMessage = result.ok ? '' : redactApiKey(result.message, ai.apiKey, uiLanguage);

  // Une seule entrée d'audit, quel que soit le verdict : c'est la même action.
  // Le prompt y figure — c'est tout l'intérêt de la trace — mais jamais la clé.
  await logAudit({
    actorId: auth.userId,
    action: result.ok ? 'application.generated' : 'application.generation.failed',
    resourceType: 'application',
    resourceId: result.ok ? result.appSpec.name : null,
    after: {
      prompt: input.prompt,
      hints: input.hints ?? null,
      // Le fournisseur est une information d'exploitation, pas un secret ; la
      // clé, elle, n'entre jamais ici — ni sous son nom, ni sous sa longueur.
      provider: ai.provider,
      model: result.model,
      durationMs: result.durationMs,
      attempts: result.attempts.map((attempt) => ({
        index: attempt.index,
        ok: attempt.ok,
        issues: attempt.issues,
      })),
      tokens: result.usage,
      ...(result.ok
        ? { slug: result.appSpec.name, services: result.appSpec.services.map((s) => s.name) }
        : { reason: result.reason, error: failureMessage, issues: result.issues }),
    },
    ip: auth.ip,
  });

  if (!result.ok) {
    logger.warn(
      {
        reason: result.reason,
        provider: ai.provider,
        model: result.model,
        message: failureMessage,
        issues: result.issues,
      },
      "génération d'AppSpec en échec",
    );
    // 422 : le modèle a répondu, sa réponse n'est pas une AppSpec valide.
    // 502 : le fournisseur n'a pas répondu du tout. Deux pannes différentes.
    throw new HttpError(
      result.reason === 'provider' ? 502 : 422,
      `generation_${result.reason}`,
      // Une panne du fournisseur alors que le modèle ne lui ressemble pas : la
      // cause est probablement là, et le message doit le dire plutôt que de
      // laisser lire un 404 brut.
      result.reason === 'provider' && modelWarning
        ? `${failureMessage} — ${modelWarning}`
        : failureMessage,
      {
        issues: result.issues,
        provider: ai.provider,
        model: result.model,
        attempts: result.attempts.length,
      },
    );
  }

  // Le slug est déduit de `appSpec.name` : on prévient tout de suite s'il est
  // déjà pris, plutôt que de laisser l'utilisateur découvrir le 409 après avoir
  // relu la spec.
  const existing = await getApplicationBySlug(result.appSpec.name);

  return NextResponse.json({
    appSpec: result.appSpec,
    provider: ai.provider,
    providerLabel,
    model: result.model,
    modelWarning,
    prompt: input.prompt,
    slugTaken: existing !== null,
    attempts: result.attempts.map((attempt) => ({
      index: attempt.index,
      ok: attempt.ok,
      issues: attempt.issues,
    })),
    usage: result.usage,
    durationMs: result.durationMs,
  });
});
