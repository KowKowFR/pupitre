import { encrypt } from '@pupitre/core';
import { fetchGiteaAccount } from '@pupitre/core/sources';
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
import { giteaConnectionView, providerError } from '@/lib/sources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * La forge Gitea / Forgejo de l'instance : son adresse, le compte de son jeton.
 *
 * Aucune route ne rend le jeton : il entre, il est vérifié auprès de la forge,
 * il est chiffré, il ne ressort pas.
 */
export const GET = apiRoute(async (request) => {
  await requirePermission(request, 'settings:read');
  const connection = await getSourceConnection('gitea');
  return NextResponse.json({
    connection: connection ? giteaConnectionView(connection) : null,
    sources: connection ? await countApplicationSources(connection.id) : 0,
  });
});

const giteaInputSchema = z.object({
  /** L'adresse de la forge, telle qu'un navigateur l'ouvre : `https://codeberg.org`. */
  url: z.string().trim().url().max(500),
  token: z.string().trim().min(8).max(500),
});

/**
 * Connecter la forge — ou remplacer son jeton. Le jeton est essayé avant
 * d'être rangé : la forge doit répondre, et dire à quel compte il ouvre.
 *
 * L'adresse d'une forge qui porte déjà des liaisons ne change pas : leurs
 * dépôts vivent là-bas. On déconnecte, puis on connecte l'autre.
 */
export const PUT = apiRoute(async (request) => {
  const auth = await requirePermission(request, 'settings:manage');
  const input = await readJsonBody(request, giteaInputSchema);
  const account = await fetchGiteaAccount({ baseUrl: input.url, token: input.token }).catch(
    providerError,
  );

  const existing = await getSourceConnection('gitea');
  if (existing && sourceConnectionWebUrl(existing) !== account.baseUrl) {
    const linked = await countApplicationSources(existing.id);
    if (linked > 0) {
      throw new ConflictError(
        msg(messages, 'gitea.error.urlChange', { url: sourceConnectionWebUrl(existing), count: linked }),
      );
    }
  }

  const connection = await saveSourceConnection({
    provider: 'gitea',
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
    action: existing ? 'integration.gitea.token_replaced' : 'integration.gitea.connected',
    resourceType: 'source_connection',
    resourceId: connection.id,
    after: { url: account.baseUrl, account: account.login, version: account.version },
    ip: auth.ip,
  });
  return NextResponse.json(
    { connection: giteaConnectionView(connection), version: account.version },
    { status: existing ? 200 : 201 },
  );
});

/** Déconnecter : la connexion et ses liaisons partent ; l'historique reste. */
export const DELETE = apiRoute(async (request) => {
  const auth = await requirePermission(request, 'settings:manage');
  const removed = await deleteSourceConnection('gitea');
  if (!removed) {
    throw new NotFoundError(msg(messages, 'error.notConnected', { provider: 'Gitea' }));
  }
  await logAudit({
    actorId: auth.userId,
    action: 'integration.gitea.disconnected',
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
