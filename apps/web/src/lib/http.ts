import 'server-only';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { localizeZodError, renderMessage } from '@pupitre/core';
import { logAudit } from '@pupitre/db';
import { errors, type ErrorKey } from '@/i18n/messages/errors';
import { currentLanguage } from '@/i18n/server';
import { getEnv } from './env';
import { HttpError, msg, renderRef, type MessageRef } from './errors';
import { logger } from './logger';
import { foreignWrite, originOf } from './same-origin';
import { declareUtf8 } from './utf8-response';

/**
 * The only place in the panel that renders an API error message in the reader's
 * language.
 *
 * It is asynchronous, and that is its very reason for being: an error is thrown
 * from synchronous code, but the language lives in the database. So the
 * translation is pushed back to here, where we are already allowed to wait.
 *
 * `code` is never touched. A script filtering on `error.code` sees no difference
 * between a French instance and an English one; that is what a code is for.
 */
async function localize(message: MessageRef | undefined, fallback: string): Promise<string> {
  if (!message) return fallback;
  return renderRef(message, await currentLanguage());
}

/** A shortcut for the errors this module makes itself. */
async function localizeKey(key: ErrorKey): Promise<string> {
  return renderMessage(errors, await currentLanguage(), key);
}

export type ApiError = {
  error: { code: string; message: string; details?: unknown };
};

function jsonError(
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
 * The Route Handler wrapper. It turns the typed errors into HTTP responses: no
 * route checks a permission or makes an error by hand.
 *
 * It also refuses, before anything else, a write a browser would send from
 * another origin than the panel — see `foreignWrite()`. The refusal is traced:
 * it is the mark of a booby-trapped page, not of a mistake.
 *
 * Every answer says its charset (`declareUtf8()`): a client that does not
 * assume UTF-8 — Windows PowerShell 5.1 — reads the accents right.
 */
export function apiRoute<Context>(
  handler: (request: Request, context: Context) => Promise<Response>,
): (request: Request, context: Context) => Promise<Response> {
  return async (request, context) => declareUtf8(await respond(handler, request, context));
}

async function respond<Context>(
  handler: (request: Request, context: Context) => Promise<Response>,
  request: Request,
  context: Context,
): Promise<Response> {
  const foreign = foreignWrite(request, originOf(getEnv().BETTER_AUTH_URL));
  if (foreign) {
    await logAudit({
      action: 'request.cross_site.refused',
      resourceType: 'request',
      resourceId: null,
      after: { method: request.method, path: new URL(request.url).pathname, reason: foreign },
      ip: clientIp(request),
    });
    return jsonError(403, 'cross_site_request', await localizeKey('cross_site'));
  }
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
      // Pupitre's schema complaints carry their key: we say them again in the screen's
      // language before flattening them.
      return jsonError(
        422,
        'validation_failed',
        await localizeKey('validation.schema'),
        z.flattenError(localizeZodError(error, await currentLanguage())),
      );
    }
    logger.error(
      { err: error, method: request.method, url: request.url },
      'unhandled error in a route',
    );
    return jsonError(500, 'internal_error', await localizeKey('internal'));
  }
}

/** A throwing variant: the `apiRoute()` wrapper turns the `ZodError` into a 422. */
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
 * A request's raw body, bounded: the read stops **during** the transfer as soon
 * as the bound is crossed, without waiting to have received everything. The
 * `content-length` header, when present, allows refusing before even reading.
 * Serves image uploads, which do not go through JSON.
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

/** A `multipart/form-data` form, bounded like `readLimitedBody()`. */
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

/** Validates the query string parameters. */
export function readSearchParams<T extends z.ZodTypeAny>(request: Request, schema: T): z.infer<T> {
  return schema.parse(searchParamsOf(request));
}

/** The non-empty URL parameters, flat — before validation. */
export function searchParamsOf(request: Request): Record<string, string> {
  const url = new URL(request.url);
  const entries: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) {
    if (value !== '') entries[key] = value;
  }
  return entries;
}

/**
 * The caller's real IP behind a reverse proxy. `x-forwarded-for` is a "client,
 * proxy1, proxy2" list: the client is the first element.
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
