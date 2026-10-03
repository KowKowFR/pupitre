import { createSourceProvider, type SourceProvider } from '@pupitre/core/sources';
import {
  getSourceConnectionById,
  sourceConnectionSecrets,
  type SourceConnection,
} from '@pupitre/db';

/**
 * Le client du fournisseur d'une liaison — GitHub, Gitea —, fabriqué depuis sa
 * connexion. `null` si la connexion n'existe plus.
 *
 * Les secrets sont déchiffrés à la construction et ne vivent qu'en mémoire,
 * dans le client. Chaque client est gardé tant que sa connexion n'a pas changé :
 * les jetons d'installation d'une GitHub App (une heure de vie) servent alors
 * d'un passage de polling à l'autre, au lieu d'être réclamés chaque minute.
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
  const key = `${connection.provider}:${connection.updatedAt.getTime()}`;
  const cached = cache.get(connectionId);
  if (cached?.key === key) return { provider: cached.provider, connection };

  const provider = createSourceProvider(sourceConnectionSecrets(connection));
  cache.set(connectionId, { key, provider });
  return { provider, connection };
}
