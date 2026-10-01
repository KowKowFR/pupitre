import 'server-only';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { renderMessage } from '@pupitre/core';
import { errors, type ErrorKey } from '@/i18n/messages/errors';
import { currentLanguage } from '@/i18n/server';
import { HttpError, msg, renderRef, type MessageRef } from './errors';
import { logger } from './logger';

/**
 * Le seul endroit du panel qui rend un message d'erreur d'API dans la langue
 * du lecteur.
 *
 * Il est asynchrone, et c'est la raison même de son existence : une erreur se
 * lance depuis du code synchrone, mais la langue vit en base. On repousse donc
 * la traduction jusqu'ici, où l'on a déjà le droit d'attendre.
 *
 * `code` n'est jamais touché. Un script qui filtre sur `error.code` ne voit
 * aucune différence entre une instance française et une instance anglaise ;
 * c'est à cela que sert un code.
 */
async function localize(message: MessageRef | undefined, fallback: string): Promise<string> {
  if (!message) return fallback;
  return renderRef(message, await currentLanguage());
}

/** Raccourci pour les erreurs que ce module fabrique lui-même. */
async function localizeKey(key: ErrorKey): Promise<string> {
  return renderMessage(errors, await currentLanguage(), key);
}

export type ApiError = {
  error: { code: string; message: string; details?: unknown };
};

export function jsonError(
  status: number,
  code: string,
  message: string,
  details?: unknown,
): NextResponse<ApiError> {
  return NextResponse.json(
    { error: details === undefined ? { code, message } : { code, message, details } },
    { status },
  );
}

/**
 * Wrapper de Route Handler. Il traduit les erreurs typées en réponses HTTP :
 * aucune route ne vérifie de permission ni ne fabrique d'erreur à la main.
 */
export function apiRoute<Context>(
  handler: (request: Request, context: Context) => Promise<Response>,
): (request: Request, context: Context) => Promise<Response> {
  return async (request, context) => {
    try {
      return await handler(request, context);
    } catch (error) {
      if (error instanceof HttpError) {
        return jsonError(
          error.status,
          error.code,
          await localize(error.ref, error.message),
          error.details,
        );
      }
      if (error instanceof z.ZodError) {
        return jsonError(
          422,
          'validation_failed',
          await localizeKey('validation.schema'),
          z.flattenError(error),
        );
      }
      logger.error(
        { err: error, method: request.method, url: request.url },
        'erreur non gérée dans une route',
      );
      return jsonError(500, 'internal_error', await localizeKey('internal'));
    }
  };
}

/** Lit et valide le corps JSON d'une requête. Aucun input non validé ne passe. */
export async function parseJsonBody<T extends z.ZodTypeAny>(
  request: Request,
  schema: T,
): Promise<{ ok: true; data: z.infer<T> } | { ok: false; response: NextResponse<ApiError> }> {
  let raw: unknown;
  try {
    const text = await request.text();
    raw = text.length === 0 ? {} : JSON.parse(text);
  } catch {
    return {
      ok: false,
      response: jsonError(400, 'invalid_json', await localizeKey('invalid_json')),
    };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      response: jsonError(
        422,
        'validation_failed',
        await localizeKey('validation.body'),
        z.flattenError(parsed.error),
      ),
    };
  }
  return { ok: true, data: parsed.data };
}

/** Variante qui throw : le wrapper `apiRoute()` traduit le `ZodError` en 422. */
export async function readJsonBody<T extends z.ZodTypeAny>(
  request: Request,
  schema: T,
): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    const text = await request.text();
    raw = text.length === 0 ? {} : JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_json', msg(errors, 'invalid_json'));
  }
  return schema.parse(raw);
}

/**
 * Le corps brut d'une requête, borné : la lecture s'arrête **pendant** le
 * transfert dès que la borne est franchie, sans attendre d'avoir tout reçu.
 * L'en-tête `content-length`, quand il est là, permet de refuser avant même de
 * lire. Sert aux envois d'images, qui ne passent pas par JSON.
 */
export async function readLimitedBody(request: Request, maxBytes: number): Promise<Buffer> {
  const tooLarge = () =>
    new HttpError(413, 'payload_too_large', msg(errors, 'payload_too_large', { max: maxBytes }));
  const announced = Number(request.headers.get('content-length') ?? NaN);
  if (Number.isFinite(announced) && announced > maxBytes) throw tooLarge();
  if (!request.body) return Buffer.alloc(0);

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Un formulaire `multipart/form-data`, borné comme `readLimitedBody()`. */
export async function readLimitedFormData(request: Request, maxBytes: number): Promise<FormData> {
  const body = await readLimitedBody(request, maxBytes);
  try {
    return await new Response(new Uint8Array(body), {
      headers: { 'content-type': request.headers.get('content-type') ?? '' },
    }).formData();
  } catch {
    throw new HttpError(400, 'invalid_form', msg(errors, 'invalid_form'));
  }
}

/** Valide les paramètres de query string. */
export function readSearchParams<T extends z.ZodTypeAny>(request: Request, schema: T): z.infer<T> {
  return schema.parse(searchParamsOf(request));
}

/** Les paramètres d'URL non vides, à plat — avant validation. */
export function searchParamsOf(request: Request): Record<string, string> {
  const url = new URL(request.url);
  const entries: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) {
    if (value !== '') entries[key] = value;
  }
  return entries;
}

/**
 * IP réelle de l'appelant derrière un reverse proxy.
 * `x-forwarded-for` est une liste « client, proxy1, proxy2 » : le client est
 * le premier élément.
 */
export function clientIp(request: Request): string | null {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return (
    request.headers.get('x-real-ip') ??
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-client-ip')
  );
}
