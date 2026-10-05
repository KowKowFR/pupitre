import 'server-only';
import { findApiTokenByHash, setAuditContextProvider } from '@pupitre/db';
import { headers } from 'next/headers';
import { bearerToken, hashApiToken } from './api-token-format';

/**
 * Gives `logAudit()` the current request's browser, and the API token through
 * which it authenticated.
 *
 * `headers()` answers in a page as in a Route Handler — including in Better
 * Auth's hooks, called from its route. Outside a request (startup, background
 * job), it throws: the entry then goes out without a browser or token, which is
 * accurate.
 *
 * The token is found by its fingerprint, revoked or expired included: a revoked
 * token's refusal reads in the log with that token's name.
 */
export function installAuditContext(): void {
  setAuditContextProvider(async () => {
    try {
      const requestHeaders = await headers();
      const bearer = bearerToken(requestHeaders);
      const found =
        bearer === null || bearer === 'malformed'
          ? null
          : await findApiTokenByHash(hashApiToken(bearer));
      return { userAgent: requestHeaders.get('user-agent'), apiTokenId: found?.token.id ?? null };
    } catch {
      return { userAgent: null, apiTokenId: null };
    }
  });
}
