import 'server-only';
import { decrypt, SourceProviderError } from '@pupitre/core';
import {
  GitHubSourceProvider,
  githubInstallUrl,
  type GitHubAppCredentials,
  type SourceProvider,
} from '@pupitre/core/sources';
import { getSourceConnection, type SourceConnection } from '@pupitre/db';
import { sources as messages } from '@/i18n/messages/sources';
import { HttpError, msg } from '@/lib/errors';
import { getEnv } from '@/lib/env';

/**
 * Le fournisseur de code, vu du panel.
 *
 * Le panel s'en sert pour deux choses seulement : montrer les installations de
 * l'App et lister les dépôts dans le tiroir de liaison. Tout le reste — lire la
 * branche, déployer, écrire les statuts — est l'affaire du worker. La clé
 * privée est déchiffrée à l'appel et ne quitte pas le serveur.
 */

/** Cookie du jeton anti-rejeu de la création de l'App. Dix minutes, puis il expire. */
export const GITHUB_STATE_COOKIE = 'pupitre_github_state';

/** L'origine publique du panel, telle que le navigateur la connaît. */
export function panelOrigin(): string {
  return new URL(getEnv().BETTER_AUTH_URL).origin;
}

export function credentialsOf(connection: SourceConnection): GitHubAppCredentials {
  return {
    appId: connection.appId,
    privateKey: decrypt(connection.privateKeyEncrypted),
    ...(connection.apiUrl ? { apiUrl: connection.apiUrl } : {}),
  };
}

export async function sourceProvider(): Promise<{
  provider: SourceProvider;
  connection: SourceConnection;
} | null> {
  const connection = await getSourceConnection('github');
  if (!connection) return null;
  return { provider: new GitHubSourceProvider(credentialsOf(connection)), connection };
}

/** Ce que l'écran peut savoir d'une connexion : tout, sauf la clé. */
export type ConnectionView = {
  appId: number;
  slug: string;
  name: string;
  htmlUrl: string;
  owner: string;
  installUrl: string;
  createdAt: string;
};

export function connectionView(connection: SourceConnection): ConnectionView {
  return {
    appId: connection.appId,
    slug: connection.slug,
    name: connection.name,
    htmlUrl: connection.htmlUrl,
    owner: connection.owner,
    installUrl: githubInstallUrl(connection.slug),
    createdAt: connection.createdAt.toISOString(),
  };
}

/** Une erreur de GitHub, rendue au format du panel : le message de GitHub, cité. */
export function providerError(error: unknown): never {
  if (error instanceof SourceProviderError) {
    // 502 : c'est le fournisseur qui a refusé, pas l'appelant qui s'est trompé.
    throw new HttpError(
      502,
      'provider_error',
      msg(messages, 'error.github', { message: error.message }),
    );
  }
  throw error;
}
