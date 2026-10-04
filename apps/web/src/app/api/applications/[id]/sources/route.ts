import {
  SourceBindingConflictError,
  applicationSourceCreateSchema,
  createApplicationSource,
  listApplicationSources,
  listPendingProposals,
  logAudit,
} from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { sources as messages } from '@/i18n/messages/sources';
import { ConflictError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import {
  accessibleRepository,
  assertApplication,
  assertTargets,
  connectedProvider,
  enqueuePoll,
  sourceJson,
} from '@/lib/source-routes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

/** An application's links, and its commits awaiting approval. */
export const GET = apiRoute<Context>(async (request, context) => {
  await requirePermission(request, 'application:read');
  const { id } = paramsSchema.parse(await context.params);
  await assertApplication(id);
  const [sources, proposals] = await Promise.all([
    listApplicationSources(id),
    listPendingProposals(id),
  ]);
  return NextResponse.json({ items: sources.map(sourceJson), proposals });
});

/**
 * Linking the application to a branch of a repository.
 *
 * The repository must be accessible to Pupitre at its provider (we check with the
 * provider: a repository coming from a form is not taken at its word), and each
 * target must have shown its runtime at preflight. A check goes out right away:
 * it notes the head commit, without deploying it.
 */
export const POST = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'application:update');
  const { id } = paramsSchema.parse(await context.params);
  const input = await readJsonBody(request, applicationSourceCreateSchema);
  const application = await assertApplication(id);

  const access = await connectedProvider(input.provider);
  const repository = await accessibleRepository(
    access.provider,
    input.repository,
    input.installationId,
  );
  await assertTargets(input.targets);

  const source = await createApplicationSource({
    ...input,
    installationId: repository.installationId,
    applicationId: id,
    connectionId: access.connection.id,
    createdBy: auth.userId,
  }).catch((error: unknown) => {
    if (error instanceof SourceBindingConflictError) {
      throw new ConflictError(msg(messages, 'error.bindingConflict'));
    }
    throw error;
  });

  await logAudit({
    actorId: auth.userId,
    action: 'source.linked',
    resourceType: 'application_source',
    resourceId: source.id,
    after: {
      applicationSlug: application.slug,
      provider: input.provider,
      repository: source.repository,
      branch: source.branch,
      specPath: source.specPath,
      watchPaths: source.watchPaths,
      mode: source.mode,
      deployTo: source.deployTo,
      targets: source.targets.map((target) => `${target.targetName}:${target.runtime}`),
    },
    ip: auth.ip,
  });

  await enqueuePoll({ sourceId: source.id, force: true, actorId: auth.userId, ip: auth.ip });
  return NextResponse.json(sourceJson(source), { status: 201 });
});
