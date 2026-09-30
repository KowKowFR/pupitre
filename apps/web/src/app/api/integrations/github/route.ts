import { encrypt } from '@pupitre/core';
import { fetchGitHubAppInfo, listGitHubInstallations } from '@pupitre/core/sources';
import {
  deleteSourceConnection,
  getSourceConnection,
  logAudit,
  saveSourceConnection,
} from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { sources as messages } from '@/i18n/messages/sources';
import { HttpError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { connectionView, credentialsOf, providerError } from '@/lib/sources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * La GitHub App de l'instance : son état, ses installations.
 *
 * Aucune route ne rend la clé privée : elle entre chiffrée, elle ne ressort pas.
 */
export const GET = apiRoute(async (request) => {
  await requirePermission(request, 'settings:read');
  const connection = await getSourceConnection('github');
  if (!connection) return NextResponse.json({ connection: null, installations: [] });
  const installations = await listGitHubInstallations(credentialsOf(connection)).catch(
    providerError,
  );
  return NextResponse.json({ connection: connectionView(connection), installations });
});

const manualSchema = z.object({
  appId: z.coerce.number().int().positive(),
  privateKey: z.string().trim().min(1).max(10_000),
});

/**
 * Connecter une App créée à la main sur GitHub : son identifiant et sa clé.
 * Les deux sont vérifiés auprès de GitHub avant d'être rangés.
 */
export const POST = apiRoute(async (request) => {
  const auth = await requirePermission(request, 'settings:manage');
  const body = await readJsonBody(request, manualSchema);
  // Une clé tronquée ou collée à côté se dit en clair, pas en erreur de schéma.
  if (body.privateKey.length < 64 || !body.privateKey.includes('PRIVATE KEY')) {
    throw new HttpError(422, 'invalid_private_key', msg(messages, 'error.privateKey'));
  }

  const info = await fetchGitHubAppInfo({ appId: body.appId, privateKey: body.privateKey }).catch(
    providerError,
  );
  const connection = await saveSourceConnection({
    provider: 'github',
    appId: info.appId,
    slug: info.slug,
    name: info.name,
    htmlUrl: info.htmlUrl,
    owner: info.owner,
    apiUrl: null,
    privateKeyEncrypted: encrypt(body.privateKey),
    createdBy: auth.userId,
  });

  await logAudit({
    actorId: auth.userId,
    action: 'integration.github.connected',
    resourceType: 'source_connection',
    resourceId: connection.id,
    after: { appId: info.appId, slug: info.slug, owner: info.owner, via: 'manual' },
    ip: auth.ip,
  });
  return NextResponse.json({ connection: connectionView(connection) }, { status: 201 });
});

/** Déconnecter : la connexion et ses liaisons partent ; l'historique reste. */
export const DELETE = apiRoute(async (request) => {
  const auth = await requirePermission(request, 'settings:manage');
  const removed = await deleteSourceConnection('github');
  if (!removed) throw new NotFoundError(msg(messages, 'error.notConnected'));

  await logAudit({
    actorId: auth.userId,
    action: 'integration.github.disconnected',
    resourceType: 'source_connection',
    resourceId: removed.connection.id,
    before: {
      appId: removed.connection.appId,
      slug: removed.connection.slug,
      owner: removed.connection.owner,
    },
    after: { sourcesRemoved: removed.sources },
    ip: auth.ip,
  });
  return NextResponse.json({ ok: true, sourcesRemoved: removed.sources });
});
