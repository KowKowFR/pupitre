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
  /** The repository's provider; GitHub when nothing is said. */
  provider: z.enum(SOURCE_PROVIDER_KINDS).default('github'),
  repository: sourceRepositorySchema,
  /** GitHub : l'installation de l'App. Rien chez Gitea ni GitLab. */
  installationId: z.coerce.number().int().positive().optional(),
  /** Absent: the repository's default branch. */
  branch: z.string().trim().min(1).max(255).optional(),
});

/**
 * A branch's `pupitre.json` files, to create an application from its repository
 * without having to type their path. With the commit read: it is the one the
 * creation will take.
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
