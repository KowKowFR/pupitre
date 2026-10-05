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
  /**
   * Le client de modèle, **injecté** : ni le fournisseur ni la clé n'entrent
   * ici. C'est ce qui rend toute la chaîne vérifiable hors ligne, avec un
   * `MockLanguageModelV3` qui rend les réponses qu'on veut éprouver.
   */
  model: LanguageModel;
  /** Nom lisible du modèle, pour l'audit. Le `LanguageModel` ne le porte pas toujours. */
  modelName: string;
  input: GenerateAppSpecInput;
  timeoutMs?: number;
  /** Injectable pour les tests : `AbortSignal.timeout` par défaut. */
  signal?: AbortSignal;
  /** Réglage d'instance. Basse par défaut : on veut une spec, pas de la prose. */
  temperature?: number;
  /**
   * Plafond de sortie. Une AppSpec multi-services fait facilement 2 000 jetons ;
   * trop bas, la réponse est tronquée et le JSON illisible — cas diagnostiqué
   * explicitement plus bas, parce qu'il ressemble à tort à un modèle défaillant.
   */
  maxOutputTokens?: number;
  /**
   * Options propres au fournisseur, opaques ici. Elles viennent de sa fabrique
   * (`createModel()`) et sont transmises telles quelles : c'est ce qui permet à
   * ce module d'ignorer complètement qui répond — un `if (provider === …)` ici
   * serait exactement la fuite que l'architecture cherche à empêcher.
   */
  providerOptions?: ProviderCallOptions;
  /**
   * La langue de ce qui revient à l'écran : le message d'échec et les
   * reproches des tentatives. Le dialogue avec le modèle, lui, reste dans la
   * langue du prompt. Français par défaut.
   */
  language?: UiLanguage;
};

/**
 * Le JSON Schema tel qu'il part réellement chez le fournisseur.
 *
 * Publié pour être inspecté hors ligne : c'est dans cette forme que se trouve
 * le `oneOf` que le mode strict d'OpenAI refuse. Sans un moyen de le regarder
 * sans clé, la régression ne se voit qu'au premier utilisateur qui en a une.
 */
export function appSpecJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(appSpecShapeSchema, { io: 'input' }) as Record<string, unknown>;
}

/** Reproches de Zod aplatis en lignes « chemin : message », dans la langue demandée. */
export function formatIssues(error: z.ZodError, language: UiLanguage = 'fr'): string[] {
  const say = aiSay(language);
  return error.issues.map((issue) =>
    say('issue', {
      path: issue.path.length > 0 ? issue.path.join('.') : say('root'),
      message: issueMessage(issue, language),
    }),
  );
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
  const language = options.language ?? 'fr';
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
        temperature: options.temperature ?? DEFAULT_TEMPERATURE,
        ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}),
        // Opaques : elles viennent de la fabrique du fournisseur. C'est là que
        // vit la connaissance de ce que chacun sait avaler — le mode strict des
        // sorties structurées, notamment, qu'OpenAI refuse d'appliquer au
        // `oneOf` que Zod produit pour `sourceSchema`. Écrire ce réglage ici
        // reviendrait à nommer un fournisseur dans un module qui ne doit pas
        // savoir qui répond.
        ...(options.providerOptions ? { providerOptions: options.providerOptions } : {}),
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
              ? repairMessage(formatIssues(zodError))
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
      { role: 'user', content: repairMessage(formatIssues(parsed.error)) },
    );
  }

  // Inatteignable : la boucle rend la main dans tous les cas.
  throw new Error('generateAppSpec : boucle de génération sortie sans verdict');
}

/**
 * Réponse coupée au plafond de jetons.
 *
 * Elle arrive ici sous la même forme qu'un modèle qui bafouille — du JSON
 * inachevé, donc pas d'objet — alors que la cause et le remède n'ont rien à
 * voir. Sans ce test, l'opérateur lit « le modèle n'a pas produit d'objet » et
 * change de modèle, là où il suffisait de relever une limite.
 */
function truncated(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const candidate = current as { finishReason?: unknown; text?: unknown; cause?: unknown };
    if (candidate.finishReason === 'length') return true;

    // Le SDK ne remonte pas toujours `finishReason` : il laisse en revanche le
    // texte brut. Un JSON qui *commence* bien et s'arrête au milieu n'est pas un
    // modèle qui bafouille, c'est une réponse coupée.
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

function messageOf(error: unknown, language: UiLanguage = 'fr'): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return aiSay(language)('timeout');
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
