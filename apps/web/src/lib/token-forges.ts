import 'server-only';
import {
  SOURCE_PROVIDER_LABELS,
  SourceProviderError,
  encrypt,
  type UiLanguage,
} from '@pupitre/core';
import { fetchGiteaAccount, fetchGitLabAccount } from '@pupitre/core/sources';
import {
  countApplicationSources,
  deleteSourceConnection,
  getSourceConnection,
  logAudit,
  saveSourceConnection,
  sourceConnectionWebUrl,
} from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { currentLanguage } from '@/i18n/server';
import { sources as messages } from '@/i18n/messages/sources';
import { ConflictError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { providerError, tokenForgeConnectionView } from '@/lib/sources';

/**
 * The forges that open with a token — Gitea / Forgejo, GitLab: an address, a
 * token tried before being stored, encrypted, which never comes out. The same
 * routes for each (`/api/integrations/{gitea,gitlab}`); only the question asked of
 * the forge to check the token differs.
 */

export type TokenForgeKind = 'gitea' | 'gitlab';

export type TokenForgeAccount = {
  /** The token's account. */
  login: string;
  version: string;
  /** The forge's address, cleaned up. */
  baseUrl: string;
  /** The token's expiry (`YYYY-MM-DD`), when the forge says it. */
  expiresAt: string | null;
};

const ACCOUNT: Record<
  TokenForgeKind,
  (credentials: {
    baseUrl: string;
    token: string;
    language: UiLanguage;
  }) => Promise<TokenForgeAccount>
> = {
  gitea: async (credentials) => ({ ...(await fetchGiteaAccount(credentials)), expiresAt: null }),
  gitlab: async (credentials) => {
    const account = await fetchGitLabAccount(credentials);
    return {
      login: account.login,
      version: account.version,
      baseUrl: account.baseUrl,
      expiresAt: account.expiresAt,
    };
  },
};

const tokenInputSchema = z.object({
  /** The forge's address, as a browser opens it: `https://codeberg.org`, `https://gitlab.com`. */
  url: z.string().trim().url().max(500),
  token: z.string().trim().min(8).max(500),
});

/** `GET`, `PUT` et `DELETE` de `/api/integrations/{forge}`. */
export function tokenForgeRoutes(kind: TokenForgeKind) {
  const label = SOURCE_PROVIDER_LABELS[kind];

  const GET = apiRoute(async (request) => {
    await requirePermission(request, 'settings:read');
    const connection = await getSourceConnection(kind);
    return NextResponse.json({
      connection: connection ? tokenForgeConnectionView(connection) : null,
      sources: connection ? await countApplicationSources(connection.id) : 0,
    });
  });

  /**
   * Connecting the forge — or replacing its token. The token is tried before being
   * stored: the forge must answer, and say which account it opens to.
   *
   * The address of a forge that already carries links does not change: their
   * repositories live there. One disconnects, then connects the other.
   */
  const PUT = apiRoute(async (request) => {
    const auth = await requirePermission(request, 'settings:manage');
    const input = await readJsonBody(request, tokenInputSchema);
    const account = await ACCOUNT[kind]({
      baseUrl: input.url,
      token: input.token,
      language: await currentLanguage(),
    }).catch(providerError);

    const existing = await getSourceConnection(kind);
    if (existing && sourceConnectionWebUrl(existing) !== account.baseUrl) {
      const linked = await countApplicationSources(existing.id);
      if (linked > 0) {
        throw new ConflictError(
          msg(messages, 'forge.error.urlChange', {
            url: sourceConnectionWebUrl(existing),
            count: linked,
          }),
        );
      }
    }

    const connection = await saveSourceConnection({
      provider: kind,
      appId: null,
      slug: null,
      name: new URL(account.baseUrl).host,
      htmlUrl: account.baseUrl,
      owner: account.login,
      apiUrl: account.baseUrl,
      privateKeyEncrypted: null,
      tokenEncrypted: encrypt(input.token),
      createdBy: auth.userId,
    });

    await logAudit({
      actorId: auth.userId,
      action: existing ? `integration.${kind}.token_replaced` : `integration.${kind}.connected`,
      resourceType: 'source_connection',
      resourceId: connection.id,
      after: {
        url: account.baseUrl,
        account: account.login,
        version: account.version,
        ...(account.expiresAt ? { expiresAt: account.expiresAt } : {}),
      },
      ip: auth.ip,
    });
    return NextResponse.json(
      {
        connection: tokenForgeConnectionView(connection),
        version: account.version,
        expiresAt: account.expiresAt,
      },
      { status: existing ? 200 : 201 },
    );
  });

  /** Disconnecting: the connection and its links go; the history stays. */
  const DELETE = apiRoute(async (request) => {
    const auth = await requirePermission(request, 'settings:manage');
    const removed = await deleteSourceConnection(kind);
    if (!removed) {
      throw new NotFoundError(msg(messages, 'error.notConnected', { provider: label }));
    }
    await logAudit({
      actorId: auth.userId,
      action: `integration.${kind}.disconnected`,
      resourceType: 'source_connection',
      resourceId: removed.connection.id,
      before: {
        url: sourceConnectionWebUrl(removed.connection),
        account: removed.connection.owner,
        sources: removed.sources,
      },
      ip: auth.ip,
    });
    return NextResponse.json({ deleted: true, sources: removed.sources });
  });

  return { GET, PUT, DELETE };
}

/**
 * "Test": does the forge answer, and which account does the token open to?
 * Nothing is saved. A refusal from the forge is not an error of the route: it
 * comes back in `{ ok: false, error }`, to be said on the screen.
 */
export function tokenForgeCheckRoute(kind: TokenForgeKind) {
  return apiRoute(async (request) => {
    await requirePermission(request, 'settings:manage');
    const input = await readJsonBody(request, tokenInputSchema);
    try {
      const account = await ACCOUNT[kind]({
        baseUrl: input.url,
        token: input.token,
        language: await currentLanguage(),
      });
      return NextResponse.json({ ok: true, ...account });
    } catch (error) {
      if (error instanceof SourceProviderError) {
        return NextResponse.json({ ok: false, error: error.message, status: error.status });
      }
      throw error;
    }
  });
}
