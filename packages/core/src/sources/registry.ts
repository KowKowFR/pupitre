import type { UiLanguage } from '../i18n.js';
import { GiteaSourceProvider } from './gitea.js';
import { GitHubSourceProvider } from './github.js';
import { GitLabSourceProvider } from './gitlab.js';
import type { SourceConnectionSecrets, SourceProvider } from './types.js';

/**
 * The code providers' factory: a decrypted connection → its client.
 *
 * It is the only line to write, with the class, for one more provider to serve
 * everywhere — polling, linking, statuses. What comes from here already has its
 * secrets in clear: the caller decrypts them just before, and the client only
 * keeps them in memory.
 */
export function createSourceProvider(
  connection: SourceConnectionSecrets,
  language: UiLanguage,
): SourceProvider {
  switch (connection.provider) {
    case 'github':
      return new GitHubSourceProvider({
        appId: connection.appId,
        privateKey: connection.privateKey,
        ...(connection.apiUrl ? { apiUrl: connection.apiUrl } : {}),
        language,
      });
    case 'gitea':
      return new GiteaSourceProvider({
        baseUrl: connection.baseUrl,
        token: connection.token,
        language,
      });
    case 'gitlab':
      return new GitLabSourceProvider({
        baseUrl: connection.baseUrl,
        token: connection.token,
        language,
      });
  }
}
