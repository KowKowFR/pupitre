import { NextResponse } from 'next/server';
import { sources as messages } from '@/i18n/messages/sources';
import { ConflictError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { providerError, sourceProvider } from '@/lib/sources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Les dépôts auxquels l'App a accès, pour le tiroir de liaison. */
export const GET = apiRoute(async (request) => {
  await requirePermission(request, 'application:update');
  const access = await sourceProvider();
  if (!access) throw new ConflictError(msg(messages, 'error.notConnected'));
  const repositories = await access.provider.listRepositories().catch(providerError);
  return NextResponse.json({ items: repositories });
});
