import 'server-only';
import { SourceProviderError, type SourceProviderKind } from '@pupitre/core';
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
import { HttpError, msg } from '@/lib/errors';
import { getEnv } from '@/lib/env';

/**
 * Les fournisseurs de code, vus du panel.
 *
 * Le panel s'en sert pour peu de choses : montrer une connexion, lister les
 * dépôts dans le tiroir de liaison, lire les `pupitre.json` d'une branche.
 * Tout le reste — suivre la branche, déployer, écrire les statuts — est
 * l'affaire du worker. Les secrets d'une connexion sont déchiffrés à l'appel
 * et ne quittent pas le serveur.
 */

/** Cookie du jeton anti-rejeu de la création de l'App. Dix minutes, puis il expire. */
export const GITHUB_STATE_COOKIE = 'pupitre_github_state';

/** L'origine publique du panel, telle que le navigateur la connaît. */
export function panelOrigin(): string {
  return new URL(getEnv().BETTER_AUTH_URL).origin;
}

/** Les identifiants d'une GitHub App, pour ce qui ne concerne qu'elle (ses installations). */
export function githubCredentialsOf(connection: SourceConnection): GitHubAppCredentials {
  const secrets = sourceConnectionSecrets(connection);
  if (secrets.provider !== 'github') throw new Error('connexion GitHub attendue');
  return {
    appId: secrets.appId,
    privateKey: secrets.privateKey,
    ...(secrets.apiUrl ? { apiUrl: secrets.apiUrl } : {}),
  };
}

/** Le client d'une connexion. */
export function providerOf(connection: SourceConnection): SourceProvider {
  return createSourceProvider(sourceConnectionSecrets(connection));
}

/** Le client d'un fournisseur, s'il est connecté. */
export async function sourceProvider(kind: SourceProviderKind): Promise<{
  provider: SourceProvider;
  connection: SourceConnection;
} | null> {
  const connection = await getSourceConnection(kind);
  if (!connection) return null;
  return { provider: providerOf(connection), connection };
}

/** Tous les fournisseurs connectés. */
export async function sourceProviders(): Promise<
  Array<{ provider: SourceProvider; connection: SourceConnection }>
> {
  return (await listSourceConnections()).map((connection) => ({
    provider: providerOf(connection),
    connection,
  }));
}

/** Ce que l'écran peut savoir de la GitHub App : tout, sauf la clé. */
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

/** Ce que l'écran peut savoir d'une forge à jeton — Gitea, GitLab : tout, sauf le jeton. */
export type TokenForgeConnectionView = {
  /** L'adresse de la forge. */
  url: string;
  /** Le compte du jeton. */
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

/** Une forge connectée, telle que les écrans de liaison la montrent. */
export type ForgeView = {
  provider: SourceProviderKind;
  /** « GitHub », ou l'hôte de la forge Gitea ou GitLab. */
  label: string;
  webUrl: string;
  /** GitHub : où choisir les dépôts de l'App. */
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

/** Une erreur du fournisseur, rendue au format du panel : son message, cité. */
export function providerError(error: unknown): never {
  if (error instanceof SourceProviderError) {
    // 502 : c'est le fournisseur qui a refusé, pas l'appelant qui s'est trompé.
    throw new HttpError(
      502,
      'provider_error',
      msg(messages, 'error.provider', { message: error.message }),
    );
  }
  throw error;
}
