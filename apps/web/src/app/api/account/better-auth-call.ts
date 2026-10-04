import 'server-only';
import { NextResponse } from 'next/server';
import { account } from '@/i18n/messages/account';
import { HttpError, msg, type MessageRef } from '@/lib/errors';

/**
 * Glue between the Better Auth endpoints and the panel's HTTP conventions.
 *
 * The account routes reimplement neither hashing nor TOTP verification: they
 * call Better Auth with `asResponse: true`, then translate its response. Two
 * details nothing else does in their place:
 *
 *  - the `Set-Cookie`s must be relayed — Better Auth rotates the session cookie
 *    at each sensitive operation, and losing them would sign out the user who
 *    just secured their account;
 *  - its error codes must become ours, otherwise the client receives two error
 *    formats depending on the route it called.
 */

type BetterAuthErrorBody = { code?: unknown; message?: unknown };

/**
 * Explicit mappings: everything else falls back on a generic 400.
 *
 * The sentences are **references** (`msg()`) and not strings: this module is
 * loaded at startup, long before a request exists, so it has no way of reading
 * the instance's language. `apiRoute()` will render it at serialization time.
 */
const TRANSLATIONS: Record<string, { status: number; code: string; message: MessageRef }> = {
  INVALID_PASSWORD: {
    status: 400,
    code: 'invalid_password',
    message: msg(account, 'error.invalidPassword'),
  },
  PASSWORD_TOO_SHORT: {
    status: 422,
    code: 'password_too_short',
    message: msg(account, 'error.passwordTooShort'),
  },
  PASSWORD_TOO_LONG: {
    status: 422,
    code: 'password_too_long',
    message: msg(account, 'error.passwordTooLong'),
  },
  CREDENTIAL_ACCOUNT_NOT_FOUND: {
    status: 409,
    code: 'no_credential_account',
    message: msg(account, 'error.noCredentialAccount'),
  },
  INVALID_CODE: {
    status: 400,
    code: 'invalid_code',
    message: msg(account, 'error.invalidCode'),
  },
  TOTP_NOT_ENABLED: {
    status: 409,
    code: 'totp_not_enabled',
    message: msg(account, 'error.totpNotEnabled'),
  },
  TOTP_ALREADY_ENABLED: {
    status: 409,
    code: 'totp_already_enabled',
    message: msg(account, 'error.totpAlreadyEnabled'),
  },
  TWO_FACTOR_NOT_ENABLED: {
    status: 409,
    code: 'two_factor_not_enabled',
    message: msg(account, 'error.twoFactorNotEnabled'),
  },
  ACCOUNT_TEMPORARILY_LOCKED: {
    status: 429,
    code: 'account_locked',
    message: msg(account, 'error.accountLocked'),
  },
};

/** The error code carried by the response, when it carries one. */
async function readErrorCode(response: Response): Promise<string | null> {
  const body: unknown = await response.clone().json().catch(() => null);
  if (typeof body !== 'object' || body === null) return null;
  const { code } = body as BetterAuthErrorBody;
  return typeof code === 'string' ? code : null;
}

/**
 * Lets a successful Better Auth response through, turns the failure into an
 * `HttpError` — which `apiRoute()` renders in the panel's error format. Returns
 * the Better Auth error code for the failure's audit.
 */
export async function assertBetterAuthOk(
  response: Response,
  fallback: MessageRef,
): Promise<void> {
  if (response.ok) return;
  const code = await readErrorCode(response);
  const known = code ? TRANSLATIONS[code] : undefined;
  if (known) throw new HttpError(known.status, known.code, known.message, { authCode: code });
  throw new HttpError(response.status === 200 ? 400 : response.status, 'auth_rejected', fallback, {
    authCode: code,
  });
}

/** The panel's JSON response, plus the cookies set by Better Auth. */
export function withAuthCookies<T>(payload: T, source: Response): NextResponse<T> {
  const response = NextResponse.json(payload);
  for (const cookie of source.headers.getSetCookie()) {
    response.headers.append('set-cookie', cookie);
  }
  return response;
}
