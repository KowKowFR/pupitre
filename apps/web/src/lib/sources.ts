import 'server-only';
import { SourceProviderError, type SourceProviderKind, type UiLanguage } from '@pupitre/core';
import {
  createSourceProvider,
  githubInstallUrl,
  type GitHubAppCredentials,
  type SourceProvider,
} from '@pupitre/core/sources';
import {
  getSourceConnection,
  listSourceConnections,
  sourceConnectionSecrets,
  sourceConnectionWebUrl,
  type SourceConnection,
} from '@pupitre/db';
import { sources as messages } from '@/i18n/messages/sources';
import { currentLanguage } from '@/i18n/server';
import { HttpError, msg } from '@/lib/errors';
import { getEnv } from '@/lib/env';

/**
 * The code providers, seen from the panel.
 *
 * The panel uses them for few things: showing a connection, listing the
 * repositories in the link drawer, reading a branch's `pupitre.json` files.
 * Everything else — following the branch, deploying, writing the statuses — is
 * the worker's business. A connection's secrets are decrypted at call time and
 * do not leave the server.
 */

/** The cookie of the App creation's anti-replay token. Ten minutes, then it expires. */
export const GITHUB_STATE_COOKIE = 'pupitre_github_state';

/** The panel's public origin, as the browser knows it. */
export function panelOrigin(): string {
  return new URL(getEnv().BETTER_AUTH_URL).origin;
}

/** A GitHub App's credentials, for what only concerns it (its installations). */
export function githubCredentialsOf(
  connection: SourceConnection,
  language: UiLanguage,
): GitHubAppCredentials {
  const secrets = sourceConnectionSecrets(connection);
  if (secrets.provider !== 'github') throw new Error('a GitHub connection was expected');
  return {
    language,
    appId: secrets.appId,
    privateKey: secrets.privateKey,
    ...(secrets.apiUrl ? { apiUrl: secrets.apiUrl } : {}),
  };
}

/** A connection's client. */
export function providerOf(connection: SourceConnection, language: UiLanguage): SourceProvider {
  return createSourceProvider(sourceConnectionSecrets(connection), language);
}

/** A provider's client, if it is connected. */
export async function sourceProvider(kind: SourceProviderKind): Promise<{
  provider: SourceProvider;
  connection: SourceConnection;
} | null> {
  const connection = await getSourceConnection(kind);
  if (!connection) return null;
  return { provider: providerOf(connection, await currentLanguage()), connection };
}

/** All the connected providers. */
export async function sourceProviders(): Promise<
  Array<{ provider: SourceProvider; connection: SourceConnection }>
> {
  const language = await currentLanguage();
  return (await listSourceConnections()).map((connection) => ({
    provider: providerOf(connection, language),
    connection,
  }));
}

/** What the screen can know of the GitHub App: everything, except the key. */
export type GitHubConnectionView = {
  appId: number | null;
  slug: string | null;
  name: string;
  htmlUrl: string;
  owner: string;
  installUrl: string | null;
  createdAt: string;
};

export function githubConnectionView(connection: SourceConnection): GitHubConnectionView {
  return {
    appId: connection.appId,
    slug: connection.slug,
    name: connection.name,
    htmlUrl: connection.htmlUrl,
    owner: connection.owner,
    installUrl: connection.slug ? githubInstallUrl(connection.slug) : null,
    createdAt: connection.createdAt.toISOString(),
  };
}

/** What the screen can know of a token forge — Gitea, GitLab: everything, except the token. */
export type TokenForgeConnectionView = {
  /** The forge's address. */
  url: string;
  /** The token's account. */
  account: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export function tokenForgeConnectionView(connection: SourceConnection): TokenForgeConnectionView {
  return {
    url: sourceConnectionWebUrl(connection),
    account: connection.owner,
    name: connection.name,
    createdAt: connection.createdAt.toISOString(),
    updatedAt: connection.updatedAt.toISOString(),
  };
}

/** A connected forge, as the link screens show it. */
export type ForgeView = {
  provider: SourceProviderKind;
  /** "GitHub", or the Gitea or GitLab forge's host. */
  label: string;
  webUrl: string;
  /** GitHub: where to choose the App's repositories. */
  installUrl: string | null;
};

export function forgeView(connection: SourceConnection): ForgeView {
  const webUrl = sourceConnectionWebUrl(connection);
  return {
    provider: connection.provider,
    label: connection.provider === 'github' ? 'GitHub' : new URL(webUrl).host,
    webUrl,
    installUrl:
      connection.provider === 'github' && connection.slug
        ? githubInstallUrl(connection.slug)
        : null,
  };
}

/** A provider error, rendered in the panel's format: its message, quoted. */
export function providerError(error: unknown): never {
  if (error instanceof SourceProviderError) {
    // 502: it is the provider that refused, not the caller that got it wrong.
    throw new HttpError(
      502,
      'provider_error',
      msg(messages, 'error.provider', { message: error.message }),
    );
  }
  throw error;
}
