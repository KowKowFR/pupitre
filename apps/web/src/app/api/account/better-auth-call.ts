import 'server-only';
import { NextResponse } from 'next/server';
import { account } from '@/i18n/messages/account';
import { HttpError, msg, type MessageRef } from '@/lib/errors';

/**
 * Colle entre les endpoints Better Auth et les conventions HTTP du panel.
 *
 * Les routes de compte ne réimplémentent ni le hachage, ni la vérification
 * TOTP : elles appellent Better Auth avec `asResponse: true`, puis traduisent
 * sa réponse. Deux détails que rien d'autre ne fait à leur place :
 *
 *  - les `Set-Cookie` doivent être relayés — Better Auth fait tourner le cookie
 *    de session à chaque opération sensible, et les perdre déconnecterait
 *    l'utilisateur qui vient précisément de sécuriser son compte ;
 *  - ses codes d'erreur doivent devenir les nôtres, sinon le client reçoit deux
 *    formats d'erreur selon la route qu'il a appelée.
 */

type BetterAuthErrorBody = { code?: unknown; message?: unknown };

/**
 * Correspondances explicites : tout le reste retombe sur un 400 générique.
 *
 * Les phrases sont des **références** (`msg()`) et non des chaînes : ce module
 * est chargé au démarrage, bien avant qu'une requête existe, et il n'a donc
 * aucun moyen d'aller lire la langue de l'instance. `apiRoute()` la rendra au
 * moment de sérialiser.
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

/** Code d'erreur porté par la réponse, quand elle en porte un. */
async function readErrorCode(response: Response): Promise<string | null> {
  const body: unknown = await response.clone().json().catch(() => null);
  if (typeof body !== 'object' || body === null) return null;
  const { code } = body as BetterAuthErrorBody;
  return typeof code === 'string' ? code : null;
}

/**
 * Laisse passer une réponse Better Auth réussie, transforme l'échec en
 * `HttpError` — que `apiRoute()` rend au format d'erreur du panel.
 * Retourne le code d'erreur Better Auth pour l'audit de l'échec.
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

/** Réponse JSON du panel, augmentée des cookies posés par Better Auth. */
export function withAuthCookies<T>(payload: T, source: Response): NextResponse<T> {
  const response = NextResponse.json(payload);
  for (const cookie of source.headers.getSetCookie()) {
    response.headers.append('set-cookie', cookie);
  }
  return response;
}
