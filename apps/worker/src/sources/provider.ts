import { decrypt } from '@pupitre/core';
import { GitHubSourceProvider, type SourceProvider } from '@pupitre/core/sources';
import { getSourceConnection, type SourceConnection } from '@pupitre/db';

/**
 * Le fournisseur de code de l'instance, ou `null` si aucune GitHub App n'est
 * connectée.
 *
 * La clé privée est déchiffrée à la construction et ne vit qu'en mémoire, dans
 * le client. L'instance est gardée tant que la connexion n'a pas changé : ses
 * jetons d'installation (une heure de vie) servent alors d'un passage de
 * polling à l'autre, au lieu d'être réclamés à chaque minute.
 */
let cached: { key: string; provider: SourceProvider; connection: SourceConnection } | null = null;

export async function getSourceProvider(): Promise<{
  provider: SourceProvider;
  connection: SourceConnection;
} | null> {
  const connection = await getSourceConnection('github');
  if (!connection) {
    cached = null;
    return null;
  }
  const key = `${connection.id}:${connection.updatedAt.getTime()}`;
  if (cached?.key === key) return { provider: cached.provider, connection };

  const provider = new GitHubSourceProvider({
    appId: connection.appId,
    privateKey: decrypt(connection.privateKeyEncrypted),
    ...(connection.apiUrl ? { apiUrl: connection.apiUrl } : {}),
  });
  cached = { key, provider, connection };
  return { provider, connection };
}
