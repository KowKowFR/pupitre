import { NoObjectGeneratedError, generateObject, type LanguageModel } from 'ai';
import { z } from 'zod';
import {
  appSpecShapeSchema,
  safeParseAppSpec,
  type AppSpec,
} from '../spec/app-spec.js';
import { generateAppSpecPrompt } from './prompt.js';

/**
 * Génération d'une AppSpec à partir d'une description en langage naturel.
 *
 * Le LLM ne produit **jamais** de shell. Il produit un objet, contraint par le
 * schéma de sortie structurée, que notre code valide ensuite avec
 * `appSpecSchema` — refinements compris. Rien n'est persisté ici, rien n'est
 * déployé : la fonction rend une AppSpec ou une erreur.
 *
 * Deux passes au maximum. Si la première viole une contrainte croisée (deux
 * services exposés, un cycle de dépendances), on relance **une seule fois** en
 * réinjectant les reproches de Zod. Si la seconde échoue aussi, on rend la main
 * avec les erreurs : « réparer » le JSON à la main reviendrait à inventer la
 * moitié de la spec sans que personne ne l'ait demandé.
 */

/** Garde-fou de taille. Un prompt de 8 000 caractères ne décrit plus une application. */
export const MAX_PROMPT_LENGTH = 4000;
export const MIN_PROMPT_LENGTH = 8;

/** Au-delà, on considère que le modèle ne répondra pas. */
export const DEFAULT_TIMEOUT_MS = 60_000;

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

/** Une tentative, telle qu'elle s'est réellement passée. */
export type GenerationAttempt = {
  index: number;
  ok: boolean;
  /** Reproches de Zod, chemin compris, lisibles tels quels par un humain. */
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
   *   invalid_spec  le modèle a répondu, sa spec ne passe pas la validation
   *   no_object     le modèle n'a pas produit d'objet exploitable
   *   provider      appel impossible : réseau, quota, clé refusée, délai dépassé
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
  model: LanguageModel;
  /** Nom lisible du modèle, pour l'audit. Le `LanguageModel` ne le porte pas toujours. */
  modelName: string;
  input: GenerateAppSpecInput;
  timeoutMs?: number;
  /** Injectable pour les tests : `AbortSignal.timeout` par défaut. */
  signal?: AbortSignal;
};

/** Reproches de Zod aplatis en lignes « chemin : message ». */
export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(racine)';
    return `${path} : ${issue.message}`;
  });
}

function userMessage(input: GenerateAppSpecInput): string {
  const lines = [`Description de l'application :`, input.prompt.trim()];

  const hints = input.hints;
  if (hints && (hints.runtime || hints.database || hints.language)) {
    lines.push('', 'Contraintes supplémentaires :');
    if (hints.language) lines.push(`- langage / plateforme applicative : ${hints.language}`);
    if (hints.database) lines.push(`- base de données : ${hints.database}`);
    if (hints.runtime) {
      // Le runtime n'est PAS un champ de l'AppSpec — la spec ne connaît ni
      // Docker ni Kubernetes. On ne le transmet que comme contexte de
      // dimensionnement, et on le dit explicitement au modèle.
      lines.push(
        `- runtime de destination : ${hints.runtime}. Ne le mentionne nulle part` +
          ` dans la spec : l'AppSpec est neutre. Il ne sert qu'à dimensionner.`,
      );
    }
  }

  return lines.join('\n');
}

/** Message de relance : les reproches de Zod, mot pour mot. */
function repairMessage(issues: string[]): string {
  return [
    "La spec que tu viens de produire a été REJETÉE par la validation. Voici les",
    'reproches, chemin par chemin :',
    '',
    ...issues.map((issue) => `- ${issue}`),
    '',
    "Corrige-les tous et renvoie l'AppSpec complète et corrigée. Ne commente pas,",
    'ne t\'excuse pas, ne renvoie pas un fragment : la spec entière.',
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
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = options.signal ?? AbortSignal.timeout(timeoutMs);

  const system = generateAppSpecPrompt();
  const turns: Turn[] = [{ role: 'user', content: userMessage(options.input) }];
  const attempts: GenerationAttempt[] = [];

  // Deux passes au maximum : la génération, puis UNE relance avec les erreurs.
  for (let index = 1; index <= 2; index += 1) {
    const attemptStartedAt = Date.now();
    let object: unknown;
    let usage: GenerationUsage;

    try {
      const result = await generateObject({
        model: options.model,
        // La forme, pas les refinements : c'est notre code qui valide ensuite.
        schema: appSpecShapeSchema,
        schemaName: 'AppSpec',
        schemaDescription:
          "Spécification neutre d'une application, indépendante du runtime de déploiement",
        system,
        messages: turns,
        temperature: 0.2,
        abortSignal: signal,
      });
      object = result.object;
      usage = usageOf(result.usage);
    } catch (error) {
      // Le SDK valide déjà la *forme* : un objet qui ne la respecte pas remonte
      // ici sous forme de `ZodError` enveloppée. C'est la même faute qu'un
      // refinement violé plus bas, et elle mérite le même traitement — une
      // relance, puis un rejet. Seule une panne du fournisseur est autre chose.
      const zodError = extractZodError(error);
      const noObject = NoObjectGeneratedError.isInstance(error);
      const failedUsage = noObject ? usageOf(error.usage ?? {}) : usageOf({});

      const failed: GenerationAttempt = {
        index,
        ok: false,
        issues: zodError ? formatIssues(zodError) : [],
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
              ? repairMessage(failed.issues)
              : repairMessage([
                  `(racine) : la réponse n'était pas un objet JSON exploitable — ${messageOf(error)}`,
                ]),
          },
        );
        continue;
      }

      return {
        ok: false,
        reason: zodError ? 'invalid_spec' : noObject ? 'no_object' : 'provider',
        message: messageOf(error),
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

    const issues = formatIssues(parsed.error);
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
        message:
          "L'AppSpec produite ne respecte pas le schéma, même après une relance " +
          'avec les erreurs de validation.',
        issues,
        model: options.modelName,
        attempts,
        usage: sumUsage(attempts),
        durationMs: Date.now() - startedAt,
      };
    }

    turns.push(
      { role: 'assistant', content: safeJson(object) },
      { role: 'user', content: repairMessage(issues) },
    );
  }

  // Inatteignable : la boucle rend la main dans tous les cas.
  throw new Error('generateAppSpec : boucle de génération sortie sans verdict');
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return "Le modèle n'a pas répondu dans le délai imparti";
    }
    return error.message;
  }
  return String(error);
}

/** Le SDK enveloppe ses causes : on cherche un `ZodError` en profondeur. */
function extractZodError(error: unknown): z.ZodError | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (current instanceof z.ZodError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** Objet brut refusé par le SDK, s'il l'a conservé — sert au message de relance. */
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
