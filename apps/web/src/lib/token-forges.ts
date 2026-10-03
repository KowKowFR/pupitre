import 'server-only';
import { SOURCE_PROVIDER_LABELS, SourceProviderError, encrypt } from '@pupitre/core';
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
import { sources as messages } from '@/i18n/messages/sources';
import { ConflictError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { providerError, tokenForgeConnectionView } from '@/lib/sources';

/**
 * Les forges qui s'ouvrent par un jeton — Gitea / Forgejo, GitLab : une
 * adresse, un jeton essayé avant d'être rangé, chiffré, qui ne ressort jamais.
 * Les mêmes routes pour chacune (`/api/integrations/{gitea,gitlab}`) ; seule
 * diffère la question posée à la forge pour vérifier le jeton.
 */

export type TokenForgeKind = 'gitea' | 'gitlab';

export type TokenForgeAccount = {
  /** Le compte du jeton. */
  login: string;
  version: string;
  /** L'adresse de la forge, nettoyée. */
  baseUrl: string;
  /** L'échéance du jeton (`AAAA-MM-JJ`), quand la forge la dit. */
  expiresAt: string | null;
};

const ACCOUNT: Record<
  TokenForgeKind,
  (credentials: { baseUrl: string; token: string }) => Promise<TokenForgeAccount>
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
  /** L'adresse de la forge, telle qu'un navigateur l'ouvre : `https://codeberg.org`, `https://gitlab.com`. */
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
   * Connecter la forge — ou remplacer son jeton. Le jeton est essayé avant
   * d'être rangé : la forge doit répondre, et dire à quel compte il ouvre.
   *
   * L'adresse d'une forge qui porte déjà des liaisons ne change pas : leurs
   * dépôts vivent là-bas. On déconnecte, puis on connecte l'autre.
   */
  const PUT = apiRoute(async (request) => {
    const auth = await requirePermission(request, 'settings:manage');
    const input = await readJsonBody(request, tokenInputSchema);
    const account = await ACCOUNT[kind]({ baseUrl: input.url, token: input.token }).catch(
      providerError,
    );

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

  /** Déconnecter : la connexion et ses liaisons partent ; l'historique reste. */
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
 * « Tester » : la forge répond-elle, et à quel compte ouvre le jeton ? Rien
 * n'est enregistré. Un refus de la forge n'est pas une erreur de la route :
 * il revient dans `{ ok: false, error }`, pour être dit sur l'écran.
 */
export function tokenForgeCheckRoute(kind: TokenForgeKind) {
  return apiRoute(async (request) => {
    await requirePermission(request, 'settings:manage');
    const input = await readJsonBody(request, tokenInputSchema);
    try {
      const account = await ACCOUNT[kind]({ baseUrl: input.url, token: input.token });
      return NextResponse.json({ ok: true, ...account });
    } catch (error) {
      if (error instanceof SourceProviderError) {
        return NextResponse.json({ ok: false, error: error.message, status: error.status });
      }
      throw error;
    }
  });
}
