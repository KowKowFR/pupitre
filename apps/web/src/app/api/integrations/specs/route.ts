import { SOURCE_PROVIDER_KINDS, sourceRepositorySchema } from '@pupitre/core';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { sources as messages } from '@/i18n/messages/sources';
import { NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { accessibleRepository, connectedProvider } from '@/lib/source-routes';
import { providerError } from '@/lib/sources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  /** Le fournisseur du dépôt ; GitHub quand rien n'est dit. */
  provider: z.enum(SOURCE_PROVIDER_KINDS).default('github'),
  repository: sourceRepositorySchema,
  /** GitHub : l'installation de l'App. Rien chez Gitea ni GitLab. */
  installationId: z.coerce.number().int().positive().optional(),
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
  const access = await connectedProvider(query.provider);

  const repo = await accessibleRepository(
    access.provider,
    query.repository,
    query.installationId ?? null,
  );
  const ref = { fullName: repo.fullName, installationId: repo.installationId };
  const branch = query.branch ?? repo.defaultBranch;
  const head = await access.provider.resolveHead(ref, branch, null).catch(providerError);
  if (!head.changed) throw new NotFoundError(msg(messages, 'error.branchNotFound', { branch }));
  const specs = await access.provider.findFiles(ref, head.sha, 'pupitre.json').catch(providerError);
  return NextResponse.json({
    provider: query.provider,
    branch,
    defaultBranch: repo.defaultBranch,
    sha: head.sha,
    specs,
  });
});
