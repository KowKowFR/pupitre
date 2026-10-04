import { createSourceProvider, type SourceProvider } from '@pupitre/core/sources';
import {
  getSourceConnectionById,
  sourceConnectionSecrets,
  type SourceConnection,
} from '@pupitre/db';
import { instanceLanguage } from '../language.js';

/**
 * A link's provider client — GitHub, GitLab, Gitea —, built from its
 * connection. `null` if the connection no longer exists.
 *
 * The secrets are decrypted at construction and only live in memory, in the
 * client. Each client is kept as long as its connection has not changed: a
 * GitHub App's installation tokens (one hour of life) then serve from one
 * polling pass to the next, instead of being claimed every minute.
 */
const cache = new Map<string, { key: string; provider: SourceProvider }>();

export async function providerForConnection(connectionId: string): Promise<{
  provider: SourceProvider;
  connection: SourceConnection;
} | null> {
  const connection = await getSourceConnectionById(connectionId);
  if (!connection) {
    cache.delete(connectionId);
    return null;
  }
  // The language is part of the key: changing the instance's renews the client.
  const language = await instanceLanguage();
  const key = `${connection.provider}:${connection.updatedAt.getTime()}:${language}`;
  const cached = cache.get(connectionId);
  if (cached?.key === key) return { provider: cached.provider, connection };

  const provider = createSourceProvider(sourceConnectionSecrets(connection), language);
  cache.set(connectionId, { key, provider });
  return { provider, connection };
}
