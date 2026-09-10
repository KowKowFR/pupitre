import {
  DEFAULT_TIMEOUT_MS,
  MissingApiKeyError,
  createModel,
  generateAppSpec,
  generateAppSpecInputSchema,
  resolveAiConfig,
} from '@tp/core/ai';
import { getAiApiKey, getApplicationBySlug, getAppSettings, logAudit } from '@tp/db';
import { NextResponse } from 'next/server';
import { HttpError, NotImplementedError } from '@/lib/errors';
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
  const env = getEnv();
  const { settings } = await getAppSettings();
  const ai = resolveAiConfig({
    settings: settings.ai,
    settingsApiKey: await getAiApiKey(),
    envApiKey: env.OPENROUTER_API_KEY,
    envModel: env.OPENROUTER_MODEL,
  });

  if (!ai.enabled) {
    throw new NotImplementedError(
      settings.ai.enabled
        ? "La génération par IA est désactivée : aucune clé d'API n'est configurée sur ce panel."
        : 'La génération par IA est désactivée dans les paramètres de cette instance.',
    );
  }

  const modelName = ai.model;

  // Par utilisateur : la route coûte de l'argent, et la session est obligatoire.
  await enforceRateLimit(APPSPEC_GENERATION_RULE, auth.userId);

  let model;
  try {
    model = createModel({ apiKey: ai.apiKey, model: ai.model });
  } catch (error) {
    if (error instanceof MissingApiKeyError) {
      throw new NotImplementedError(error.message);
    }
    throw error;
  }

  const result = await generateAppSpec({
    model,
    modelName,
    input,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });

  // Une seule entrée d'audit, quel que soit le verdict : c'est la même action.
  // Le prompt y figure — c'est le point du jalon — mais jamais la clé.
  await logAudit({
    actorId: auth.userId,
    action: result.ok ? 'application.generated' : 'application.generation.failed',
    resourceType: 'application',
    resourceId: result.ok ? result.appSpec.name : null,
    after: {
      prompt: input.prompt,
      hints: input.hints ?? null,
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
        : { reason: result.reason, error: result.message, issues: result.issues }),
    },
    ip: auth.ip,
  });

  if (!result.ok) {
    logger.warn(
      { reason: result.reason, model: result.model, issues: result.issues },
      "génération d'AppSpec en échec",
    );
    // 422 : le modèle a répondu, sa réponse n'est pas une AppSpec valide.
    // 502 : le fournisseur n'a pas répondu du tout. Deux pannes différentes.
    throw new HttpError(
      result.reason === 'provider' ? 502 : 422,
      `generation_${result.reason}`,
      result.message,
      {
        issues: result.issues,
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
    model: result.model,
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
