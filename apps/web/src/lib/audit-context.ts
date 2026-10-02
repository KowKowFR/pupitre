import 'server-only';
import { findApiTokenByHash, setAuditContextProvider } from '@pupitre/db';
import { headers } from 'next/headers';
import { bearerToken, hashApiToken } from './api-token-format';

/**
 * Donne à `logAudit()` le navigateur de la requête en cours, et le jeton d'API
 * par lequel elle s'est authentifiée.
 *
 * `headers()` répond dans une page comme dans un Route Handler — y compris
 * dans les crochets de Better Auth, appelés depuis sa route. Hors requête
 * (démarrage, tâche de fond), il lève : l'entrée part alors sans navigateur ni
 * jeton, ce qui est exact.
 *
 * Le jeton est retrouvé par son empreinte, y compris révoqué ou échu : le refus
 * d'un jeton révoqué se lit au journal avec le nom de ce jeton.
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
