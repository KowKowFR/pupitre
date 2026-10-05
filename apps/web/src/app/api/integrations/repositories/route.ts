import { SOURCE_PROVIDER_LABELS, errorMessage, type SourceRepository } from '@pupitre/core';
import { NextResponse } from 'next/server';
import { sources as messages } from '@/i18n/messages/sources';
import { ConflictError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { sourceProviders } from '@/lib/sources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The repositories Pupitre can read, all providers together — for the link
 * drawer and the creation from a repository. Each one says its provider.
 *
 * A provider that does not answer does not prevent seeing the others: its error
 * is returned separately, named.
 */
export const GET = apiRoute(async (request) => {
  await requirePermission(request, 'application:update');
  const connected = await sourceProviders();
  if (connected.length === 0) throw new ConflictError(msg(messages, 'error.noProvider'));

  const items: SourceRepository[] = [];
  const errors: Array<{ provider: string; message: string }> = [];
  await Promise.all(
    connected.map(async ({ provider }) => {
      try {
        items.push(...(await provider.listRepositories()));
      } catch (error) {
        errors.push({
          provider: SOURCE_PROVIDER_LABELS[provider.kind],
          message: errorMessage(error),
        });
      }
    }),
  );
  items.sort(
    (a, b) => a.provider.localeCompare(b.provider) || a.fullName.localeCompare(b.fullName),
  );
  return NextResponse.json({ items, errors });
});
