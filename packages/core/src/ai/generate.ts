import { NoObjectGeneratedError, generateObject, type LanguageModel } from 'ai';
import type { ProviderCallOptions } from './providers.js';
import { z } from 'zod';
import {
  appSpecShapeSchema,
  safeParseAppSpec,
  type AppSpec,
} from '../spec/app-spec.js';
import type { UiLanguage } from '../i18n.js';
import { issueMessage } from '../validation.js';
import { aiSay } from './messages.js';
import { generateAppSpecPrompt } from './prompt.js';

/**
 * Generating an AppSpec from a natural-language description.
 *
 * The LLM **never** produces shell. It produces an object, constrained by the
 * structured output schema, which our code then validates with `appSpecSchema`
 * — refinements included. Nothing is persisted here, nothing is deployed: the
 * function returns an AppSpec or an error.
 *
 * Two passes at most. If the first violates a cross-field constraint (two
 * exposed services, a dependency cycle), we retry **only once**, feeding Zod's
 * complaints back. If the second fails too, we give control back with the
 * errors: "repairing" the JSON by hand would amount to making up half the spec
 * without anybody having asked for it.
 */

/** Size guardrail. An 8,000-character prompt no longer describes an application. */
export const MAX_PROMPT_LENGTH = 4000;
export const MIN_PROMPT_LENGTH = 8;

/** Beyond this, we consider that the model will not answer. */
export const DEFAULT_TIMEOUT_MS = 60_000;

export const DEFAULT_TEMPERATURE = 0.2;

export const generationHintsSchema = z.object({
  runtime: z.enum(['docker', 'k3s']).optional(),
  database: z.string().min(1).max(60).optional(),
  language: z.string().min(1).max(60).optional(),
});

export type GenerationHints = z.infer<typeof generationHintsSchema>;

export const generateAppSpecInputSchema = z.object({
  prompt: z.string().trim().min(MIN_PROMPT_LENGTH).max(MAX_PROMPT_LENGTH),
  hints: generationHintsSchema.optional(),
});

export type GenerateAppSpecInput = z.infer<typeof generateAppSpecInputSchema>;

/** An attempt, as it really went. */
export type GenerationAttempt = {
  index: number;
  ok: boolean;
  /** Zod's complaints, path included, readable as is by a human. */
  issues: string[];
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
};

export type GenerationUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
};

export type GenerateAppSpecSuccess = {
  ok: true;
  appSpec: AppSpec;
  model: string;
  attempts: GenerationAttempt[];
  usage: GenerationUsage;
  durationMs: number;
};

export type GenerateAppSpecFailure = {
  ok: false;
  /**
   *   invalid_spec  the model answered, its spec does not pass validation
   *   no_object     the model did not produce a usable object
   *   provider      the call failed: network, quota, key refused, timeout
   */
  reason: 'invalid_spec' | 'no_object' | 'provider';
  message: string;
  issues: string[];
  model: string;
  attempts: GenerationAttempt[];
  usage: GenerationUsage;
  durationMs: number;
};

export type GenerateAppSpecResult = GenerateAppSpecSuccess | GenerateAppSpecFailure;

export type GenerateAppSpecOptions = {
  /**
   * The model client, **injected**: neither the provider nor the key come in
   * here. That is what makes the whole chain verifiable offline, with a
   * `MockLanguageModelV3` that returns the answers we want to test.
   */
  model: LanguageModel;
  /** The model's readable name, for the audit log. The `LanguageModel` does not always carry it. */
  modelName: string;
  input: GenerateAppSpecInput;
  timeoutMs?: number;
  /** Injectable for tests: `AbortSignal.timeout` by default. */
  signal?: AbortSignal;
  /** Instance setting. Low by default: we want a spec, not prose. */
  temperature?: number;
  /**
   * Output cap. A multi-service AppSpec easily takes 2,000 tokens; too low, the
   * response is truncated and the JSON unreadable — a case diagnosed explicitly
   * below, because it wrongly looks like a failing model.
   */
  maxOutputTokens?: number;
  /**
   * Provider-specific options, opaque here. They come from its factory
   * (`createModel()`) and are passed on as is: that is what lets this module
   * completely ignore who answers — an `if (provider === …)` here would be exactly
   * the leak the architecture tries to prevent.
   */
  providerOptions?: ProviderCallOptions;
  /**
   * The language of what comes back to the screen: the failure message and the
   * attempts' complaints. The dialogue with the model stays in the prompt's
   * language, English.
   */
  language: UiLanguage;
};

/**
 * The JSON Schema as it really goes to the provider.
 *
 * Published to be inspected offline: it is in this shape that the `oneOf`
 * OpenAI's strict mode refuses is found. Without a way to look at it without a
 * key, the regression only shows with the first user who has one.
 */
export function appSpecJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(appSpecShapeSchema, { io: 'input' }) as Record<string, unknown>;
}

/** Zod's complaints flattened into "path: message" lines, in the requested language. */
export function formatIssues(error: z.ZodError, language: UiLanguage): string[] {
  const say = aiSay(language);
  return error.issues.map((issue) =>
    say('issue', {
      path: issue.path.length > 0 ? issue.path.join('.') : say('root'),
      message: issueMessage(issue, language),
    }),
  );
}

function userMessage(input: GenerateAppSpecInput): string {
  const lines = ['Application description:', input.prompt.trim()];

  const hints = input.hints;
  if (hints && (hints.runtime || hints.database || hints.language)) {
    lines.push('', 'Additional constraints:');
    if (hints.language) lines.push(`- application language / platform: ${hints.language}`);
    if (hints.database) lines.push(`- database: ${hints.database}`);
    if (hints.runtime) {
      // The runtime is NOT an AppSpec field — the spec knows neither Docker nor
      // Kubernetes. It is only passed on as sizing context, and we tell the model so
      // explicitly.
      lines.push(
        `- target runtime: ${hints.runtime}. Do not mention it anywhere in the spec:` +
          ' the AppSpec is neutral. It is only there for sizing.',
      );
    }
  }

  return lines.join('\n');
}

/** Retry message: Zod's complaints, word for word — in English, like the prompt. */
function repairMessage(issues: string[]): string {
  return [
    'The spec you just produced was REJECTED by validation. Here are the',
    'complaints, path by path:',
    '',
    ...issues.map((issue) => `- ${issue}`),
    '',
    'Fix them all and send back the complete, corrected AppSpec. Do not comment,',
    'do not apologize, do not send a fragment: the whole spec.',
  ].join('\n');
}

function usageOf(raw: {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
}): GenerationUsage {
  return {
    inputTokens: raw.inputTokens ?? null,
    outputTokens: raw.outputTokens ?? null,
    totalTokens: raw.totalTokens ?? null,
  };
}

function sumUsage(attempts: readonly GenerationAttempt[]): GenerationUsage {
  const add = (values: Array<number | null>): number | null =>
    values.some((value) => value !== null)
      ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
      : null;

  const input = add(attempts.map((attempt) => attempt.inputTokens));
  const output = add(attempts.map((attempt) => attempt.outputTokens));
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input === null && output === null ? null : (input ?? 0) + (output ?? 0),
  };
}

type Turn = { role: 'user' | 'assistant'; content: string };

export async function generateAppSpec(
  options: GenerateAppSpecOptions,
): Promise<GenerateAppSpecResult> {
  const startedAt = Date.now();
  const language = options.language;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = options.signal ?? AbortSignal.timeout(timeoutMs);

  const system = generateAppSpecPrompt();
  const turns: Turn[] = [{ role: 'user', content: userMessage(options.input) }];
  const attempts: GenerationAttempt[] = [];

  // Two passes at most: the generation, then ONE retry with the errors.
  for (let index = 1; index <= 2; index += 1) {
    const attemptStartedAt = Date.now();
    let object: unknown;
    let usage: GenerationUsage;

    try {
      const result = await generateObject({
        model: options.model,
        // The shape, not the refinements: it is our code that validates afterwards.
        schema: appSpecShapeSchema,
        schemaName: 'AppSpec',
        schemaDescription:
          'Neutral specification of an application, independent of the deployment runtime',
        system,
        messages: turns,
        temperature: options.temperature ?? DEFAULT_TEMPERATURE,
        ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}),
        // Opaque: they come from the provider's factory. That is where the knowledge of
        // what each one can swallow lives — the strict mode of structured outputs,
        // notably, which OpenAI refuses to apply to the `oneOf` Zod produces for
        // `sourceSchema`. Writing that setting here would mean naming a provider in a
        // module that must not know who answers.
        ...(options.providerOptions ? { providerOptions: options.providerOptions } : {}),
        abortSignal: signal,
      });
      object = result.object;
      usage = usageOf(result.usage);
    } catch (error) {
      // The SDK already validates the *shape*: an object that does not respect it
      // comes up here as a wrapped `ZodError`. It is the same fault as a refinement
      // violated below, and it deserves the same treatment — a retry, then a
      // rejection. Only a provider failure is something else.
      const zodError = extractZodError(error);
      const noObject = NoObjectGeneratedError.isInstance(error);
      const failedUsage = noObject ? usageOf(error.usage ?? {}) : usageOf({});

      const failed: GenerationAttempt = {
        index,
        ok: false,
        issues: zodError ? formatIssues(zodError, language) : [],
        inputTokens: failedUsage.inputTokens,
        outputTokens: failedUsage.outputTokens,
        durationMs: Date.now() - attemptStartedAt,
      };
      attempts.push(failed);

      if ((zodError || noObject) && index === 1) {
        turns.push(
          { role: 'assistant', content: safeJson(rawObjectOf(error)) },
          {
            role: 'user',
            content: zodError
              ? repairMessage(formatIssues(zodError, 'en'))
              : repairMessage([
                  `(root): the answer was not a usable JSON object — ${messageOf(error, 'en')}`,
                ]),
          },
        );
        continue;
      }

      return {
        ok: false,
        reason: zodError ? 'invalid_spec' : noObject ? 'no_object' : 'provider',
        message: truncated(error) ? aiSay(language)('truncated') : messageOf(error, language),
        issues: failed.issues,
        model: options.modelName,
        attempts,
        usage: sumUsage(attempts),
        durationMs: Date.now() - startedAt,
      };
    }

    const parsed = safeParseAppSpec(object);
    if (parsed.success) {
      attempts.push({
        index,
        ok: true,
        issues: [],
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        durationMs: Date.now() - attemptStartedAt,
      });
      return {
        ok: true,
        appSpec: parsed.data,
        model: options.modelName,
        attempts,
        usage: sumUsage(attempts),
        durationMs: Date.now() - startedAt,
      };
    }

    const issues = formatIssues(parsed.error, language);
    attempts.push({
      index,
      ok: false,
      issues,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      durationMs: Date.now() - attemptStartedAt,
    });

    if (index === 2) {
      return {
        ok: false,
        reason: 'invalid_spec',
        message: aiSay(language)('invalidSpec'),
        issues,
        model: options.modelName,
        attempts,
        usage: sumUsage(attempts),
        durationMs: Date.now() - startedAt,
      };
    }

    turns.push(
      { role: 'assistant', content: safeJson(object) },
      { role: 'user', content: repairMessage(formatIssues(parsed.error, 'en')) },
    );
  }

  // Unreachable: the loop returns in every case.
  throw new Error('generateAppSpec: generation loop exited without a verdict');
}

/**
 * A response cut at the token cap.
 *
 * It arrives here in the same shape as a model that stammers — unfinished JSON,
 * hence no object — whereas the cause and the remedy have nothing in common.
 * Without this test, the operator reads "the model did not produce an object"
 * and switches models, where raising a limit was enough.
 */
function truncated(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const candidate = current as { finishReason?: unknown; text?: unknown; cause?: unknown };
    if (candidate.finishReason === 'length') return true;

    // The SDK does not always report `finishReason`: it does, however, leave the
    // raw text. A JSON that *starts* well and stops in the middle is not a model
    // stammering, it is a cut response.
    if (typeof candidate.text === 'string') {
      const raw = candidate.text.trim();
      if (raw.startsWith('{')) {
        try {
          JSON.parse(raw);
        } catch (parseError) {
          if (
            parseError instanceof SyntaxError &&
            /end of (json|data|input)|unterminated/i.test(parseError.message)
          ) {
            return true;
          }
        }
      }
    }
    current = candidate.cause;
  }
  return false;
}

function messageOf(error: unknown, language: UiLanguage): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return aiSay(language)('timeout');
    }
    return error.message;
  }
  return String(error);
}

/** The SDK wraps its causes: we look for a `ZodError` in depth. */
function extractZodError(error: unknown): z.ZodError | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (current instanceof z.ZodError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** Raw object refused by the SDK, if it kept it — used for the retry message. */
function rawObjectOf(error: unknown): unknown {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const candidate = current as { value?: unknown; text?: unknown; cause?: unknown };
    if (candidate.value !== undefined) return candidate.value;
    if (typeof candidate.text === 'string') return candidate.text;
    current = candidate.cause;
  }
  return {};
}

function safeJson(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '{}';
  }
}
