import { NextResponse } from 'next/server';
import { z } from 'zod';
import { sources as messages } from '@/i18n/messages/sources';
import { ConflictError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { accessibleRepository } from '@/lib/source-routes';
import { providerError, sourceProvider } from '@/lib/sources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  installationId: z.coerce.number().int().positive(),
  /** Absente : la branche par défaut du dépôt. */
  branch: z.string().trim().min(1).max(255).optional(),
});

/**
 * Les `pupitre.json` d'une branche, pour créer une application depuis son
 * dépôt sans avoir à taper leur chemin. Avec le commit lu : c'est lui que la
 * création prendra.
 */
export const GET = apiRoute(async (request) => {
  await requirePermission(request, 'application:create');
  const query = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
  const access = await sourceProvider();
  if (!access) throw new ConflictError(msg(messages, 'error.notConnected'));

  const repo = await accessibleRepository(access.provider, query.repository, query.installationId);
  const ref = { fullName: repo.fullName, installationId: repo.installationId };
  const branch = query.branch ?? repo.defaultBranch;
  const head = await access.provider.resolveHead(ref, branch, null).catch(providerError);
  if (!head.changed) throw new NotFoundError(msg(messages, 'error.branchNotFound', { branch }));
  const specs = await access.provider.findFiles(ref, head.sha, 'pupitre.json').catch(providerError);
  return NextResponse.json({
    branch,
    defaultBranch: repo.defaultBranch,
    sha: head.sha,
    specs,
  });
});
