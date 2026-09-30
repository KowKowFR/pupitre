import 'server-only';
import { setAuditContextProvider } from '@pupitre/db';
import { headers } from 'next/headers';

/**
 * Donne à `logAudit()` le navigateur de la requête en cours.
 *
 * `headers()` répond dans une page comme dans un Route Handler — y compris
 * dans les crochets de Better Auth, appelés depuis sa route. Hors requête
 * (démarrage, tâche de fond), il lève : l'entrée part alors sans navigateur,
 * ce qui est exact.
 */
export function installAuditContext(): void {
  setAuditContextProvider(async () => {
    try {
      return { userAgent: (await headers()).get('user-agent') };
    } catch {
      return { userAgent: null };
    }
  });
}
