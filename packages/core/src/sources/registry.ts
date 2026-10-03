import { GiteaSourceProvider } from './gitea.js';
import { GitHubSourceProvider } from './github.js';
import type { SourceConnectionSecrets, SourceProvider } from './types.js';

/**
 * La fabrique des fournisseurs de code : une connexion déchiffrée → son client.
 *
 * C'est la seule ligne à écrire, avec la classe, pour qu'un fournisseur de
 * plus serve partout — le polling, la liaison, les statuts. Ce qui vient
 * d'ici a déjà ses secrets en clair : l'appelant les déchiffre juste avant, et
 * le client ne les garde qu'en mémoire.
 */
export function createSourceProvider(connection: SourceConnectionSecrets): SourceProvider {
  switch (connection.provider) {
    case 'github':
      return new GitHubSourceProvider({
        appId: connection.appId,
        privateKey: connection.privateKey,
        ...(connection.apiUrl ? { apiUrl: connection.apiUrl } : {}),
      });
    case 'gitea':
      return new GiteaSourceProvider({ baseUrl: connection.baseUrl, token: connection.token });
  }
}
