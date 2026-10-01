import {
  SourceBindingConflictError,
  applicationSourceCreateSchema,
  createApplicationSource,
  getSourceConnection,
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
import { assertApplication, assertTargets, enqueuePoll, sourceJson } from '@/lib/source-routes';
import { providerError, sourceProvider } from '@/lib/sources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

/** Les liaisons d'une application, et ses commits en attente de validation. */
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
 * Relier l'application à une branche d'un dépôt.
 *
 * Le dépôt doit être accessible à l'App (on le vérifie auprès de GitHub : un
 * identifiant d'installation ne se croit pas sur parole), et chaque cible
 * doit avoir montré son runtime au preflight. Une vérification part tout de
 * suite : elle note le commit en tête, sans le déployer.
 */
export const POST = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'application:update');
  const { id } = paramsSchema.parse(await context.params);
  const input = await readJsonBody(request, applicationSourceCreateSchema);
  const application = await assertApplication(id);

  const connection = await getSourceConnection('github');
  const access = connection ? await sourceProvider() : null;
  if (!connection || !access) throw new ConflictError(msg(messages, 'error.notConnected'));

  const repositories = await access.provider.listRepositories().catch(providerError);
  const repository = repositories.find(
    (repo) => repo.fullName === input.repository && repo.installationId === input.installationId,
  );
  if (!repository) {
    throw new ConflictError(
      msg(messages, 'error.repositoryUnavailable', { repository: input.repository }),
    );
  }
  await assertTargets(input.targets);

  const source = await createApplicationSource({
    ...input,
    applicationId: id,
    connectionId: connection.id,
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
