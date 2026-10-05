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
/** The provider has 60 s; the route gives itself a little more to return the failure. */
export const maxDuration = 90;

/**
 * Generating an AppSpec from a description.
 *
 * What this route does NOT do, and it is deliberate: it **persists nothing** and
 * **deploys nothing**. It returns an AppSpec, which the user reviews, corrects in
 * the editor, then submits to `POST /api/applications` like any other. An AI
 * writing directly to the database would take away from the operator the only
 * moment they can say no.
 *
 * It stays synchronous, against the rule "every long-running operation goes
 * through BullMQ": it is not an infrastructure operation, nothing survives the
 * call, and nobody needs to resume it after a restart. What justifies the queue —
 * resuming, a steps log, remote execution — is irrelevant here. The guardrail is
 * elsewhere: a timeout, a rate limit and a bounded prompt size.
 *
 * It is the same trade-off as `GET /api/targets/[id]/metrics`, settled for the
 * same reasons: a bounded reading, without side effects, whose result dies with
 * the response, has no business in a queue. Going through BullMQ would cost here
 * a job, a state table and a follow-up channel to give the client exactly what a
 * sixty-second call already gives it — and would make *harder* the only case that
 * matters, the operator abandoning.
 */

export const POST = apiRoute(async (request) => {
  const auth = await requirePermission(request, 'application:create');

  // The body is validated BEFORE looking at the configuration: a malformed request
  // is malformed on every panel, with or without a key. The reverse would make the
  // response depend on the deployment — a client could no longer tell "my request
  // is wrong" from "this panel has no AI".
  const input = await readJsonBody(request, generateAppSpecInputSchema);

  // The instance settings take precedence over the environment: it is the setting
  // an operator just made from the Settings screen. The environment stays the
  // safety net for a panel provisioned without anyone opening it. `getEnv()`
  // validates the panel's configuration; the AI providers' keys are not in its
  // schema, and that is deliberate: which variable to read is a property of the
  // provider, described in its descriptor. Adding a fourth provider must not
  // require touching `env.ts`.
  getEnv();
  const { settings } = await getAppSettings();
  const uiLanguage = await currentLanguage();
  const ai = resolveAiConfig({
    language: uiLanguage,
    settings: settings.ai,
    settingsApiKey: await getAiApiKey(),
    env: process.env,
  });

  const providerLabel = aiProviderDescriptor(ai.provider).label;
  // The same warning as `resolveAiConfig()`'s, but rendered in the instance's
  // language: this one ends up in an error message read on screen.
  const modelWarning = aiModelMismatch(ai.provider, ai.model, {
    baseUrl: ai.baseUrl,
    language: uiLanguage,
  });

  // The reference to the environment variable goes INTO the sentence: it cannot
  // wait for serialization, the key that carries it can.
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

  // A model that does not have the shape of a provider identifier does not produce
  // a configuration error but a 404 from the provider, a minute later. We say so
  // here, before the call, and repeat it if the call fails.
  if (ai.modelWarning) {
    logger.warn(
      { provider: ai.provider, model: ai.model },
      'AI model inconsistent with the configured provider',
    );
  }

  // Per user: the route costs money, and the session is required.
  await enforceRateLimit(APPSPEC_GENERATION_RULE, auth.userId);

  // The model comes with the options its provider requires — the strict mode of
  // structured outputs, notably, which OpenAI refuses to apply to a schema carrying
  // a `oneOf`. The route does not interpret them: it relays them.
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

  // A provider's message is not trusted text: OpenAI copies into it the refused
  // key, partially masked — hence partially in clear. It is cleaned here, once,
  // before the audit AND before the response.
  const failureMessage = result.ok ? '' : redactApiKey(result.message, ai.apiKey, uiLanguage);

  // A single audit entry, whatever the verdict: it is the same action. The prompt
  // is in it — that is the whole point of the trace — but never the key.
  await logAudit({
    actorId: auth.userId,
    action: result.ok ? 'application.generated' : 'application.generation.failed',
    resourceType: 'application',
    resourceId: result.ok ? result.appSpec.name : null,
    after: {
      prompt: input.prompt,
      hints: input.hints ?? null,
      // The provider is operating information, not a secret; the key, for its part,
      // never comes in here — neither under its name nor under its length.
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
      'AppSpec generation failed',
    );
    // 422: the model answered, its answer is not a valid AppSpec.
    // 502: the provider did not answer at all. Two different failures.
    throw new HttpError(
      result.reason === 'provider' ? 502 : 422,
      `generation_${result.reason}`,
      // A provider outage while the model does not look like one of its own: the cause
      // is probably there, and the message must say so rather than let a raw 404 be
      // read.
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

  // The slug is derived from `appSpec.name`: we warn right away if it is already
  // taken, rather than let the user discover the 409 after having reviewed the
  // spec.
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
