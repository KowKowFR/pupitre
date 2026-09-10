import 'server-only';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { HttpError } from './errors';
import { logger } from './logger';

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
        return jsonError(error.status, error.code, error.message, error.details);
      }
      if (error instanceof z.ZodError) {
        return jsonError(
          422,
          'validation_failed',
          'La requête ne respecte pas le schéma',
          z.flattenError(error),
        );
      }
      logger.error(
        { err: error, method: request.method, url: request.url },
        'erreur non gérée dans une route',
      );
      return jsonError(500, 'internal_error', 'Erreur interne');
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
    return { ok: false, response: jsonError(400, 'invalid_json', 'Corps de requête JSON invalide') };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      response: jsonError(
        422,
        'validation_failed',
        'Le corps de la requête ne respecte pas le schéma',
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
    throw new HttpError(400, 'invalid_json', 'Corps de requête JSON invalide');
  }
  return schema.parse(raw);
}

/** Valide les paramètres de query string. */
export function readSearchParams<T extends z.ZodTypeAny>(request: Request, schema: T): z.infer<T> {
  const url = new URL(request.url);
  const entries: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) {
    if (value !== '') entries[key] = value;
  }
  return schema.parse(entries);
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
