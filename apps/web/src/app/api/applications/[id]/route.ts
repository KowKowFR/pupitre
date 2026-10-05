import { appSpecSchema, renderMessage } from '@pupitre/core';
import {
  eraseApplication,
  generationOriginSchema,
  getApplication,
  listApplicationDeletionBlockers,
  logAudit,
  syncApplicationSecrets,
  updateApplication,
} from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { applications as messages } from '@/i18n/messages/applications';
import { currentLanguage } from '@/i18n/server';
import { nameConflict } from '@/lib/application-name';
import { HttpError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requireApplicationScope, requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

export const GET = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'application:read', { applicationScoped: true });
  const { id } = paramsSchema.parse(await context.params);
  await requireApplicationScope(request, auth, id);

  const application = await getApplication(id);
  if (!application) throw new NotFoundError(msg(messages, 'error.notFound', { id }));
  return NextResponse.json(application);
});

const patchSchema = z.object({
  description: z.string().max(500).optional(),
  appSpec: appSpecSchema.optional(),
  /** A regenerated AppSpec also replaces the kept provenance. */
  generation: generationOriginSchema.optional(),
});

export const PATCH = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'application:update');
  const { id } = paramsSchema.parse(await context.params);
  const patch = await readJsonBody(request, patchSchema);

  const before = await getApplication(id);
  if (!before) throw new NotFoundError(msg(messages, 'error.notFound', { id }));

  // A rename the machines would confuse is refused here — see `lib/application-name.ts`.
  const after = await updateApplication(id, patch).catch((error: unknown) => {
    throw nameConflict(error) ?? error;
  });
  if (!after) throw new NotFoundError(msg(messages, 'error.notFound', { id }));

  // An AppSpec that declares one more secret sees it created here. A secret it
  // removes is NOT deleted: its value may still serve a volume in service — see
  // `syncApplicationSecrets()`.
  const generated = await syncApplicationSecrets(id, after.appSpec);

  await logAudit({
    actorId: auth.userId,
    action: 'application.updated',
    resourceType: 'application',
    resourceId: id,
    before: { slug: before.slug, version: before.appSpec.version },
    after: {
      slug: after.slug,
      version: after.appSpec.version,
      ...(patch.generation
        ? {
            origin: 'ai',
            model: patch.generation.model,
            prompt: patch.generation.prompt,
            edited:
              JSON.stringify(patch.generation.appSpec) !== JSON.stringify(after.appSpec),
          }
        : {}),
      secretsGenerated: generated,
    },
    ip: auth.ip,
  });

  return NextResponse.json(after);
});

export const DELETE = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'application:delete');
  const { id } = paramsSchema.parse(await context.params);

  const application = await getApplication(id);
  if (!application) throw new NotFoundError(msg(messages, 'error.notFound', { id }));

  // What blocks is not "carrying deployments" — a `destroyed` deployment is a
  // history record, it holds nothing. It is carrying one the panel must not lose
  // sight of. The rule and its vocabulary are the purge's:
  // `listApplicationDeletionBlockers()`. The list goes INTO the sentence: it cannot
  // wait for serialization as `msg()` does. So we read the language here, and the
  // two pieces agree — each blocker's message too.
  const language = await currentLanguage();
  const blockers = await listApplicationDeletionBlockers(id, { language });
  if (blockers.length > 0) {
    throw new HttpError(
      409,
      'application_has_live_deployments',
      msg(messages, 'error.liveDeployments', {
        slug: application.slug,
        count: blockers.length,
        list: blockers
          .map((blocker) =>
            renderMessage(messages, language, 'error.deploymentEntry', {
              version: blocker.version,
              target: blocker.targetName,
            }),
          )
          .join(', '),
        path: new URL(request.url).pathname,
      }),
      { blockers },
    );
  }

  // No handle to lose: the remaining history is only history. `eraseApplication()`
  // erases it and **releases the ports** in the same transaction, saying which ones
  // — the foreign key cascade would do it too, but silently, and the log would have
  // nothing to tell.
  const erasure = await eraseApplication(id);
  if (!erasure) throw new NotFoundError(msg(messages, 'error.notFound', { id }));

  await logAudit({
    actorId: auth.userId,
    action: 'application.deleted',
    resourceType: 'application',
    resourceId: id,
    before: { slug: application.slug },
    after: {
      cascade: false,
      forced: false,
      erasedDeploymentIds: erasure.deploymentIds,
      erasedDeploymentCount: erasure.deploymentIds.length,
      releasedPorts: erasure.releasedPorts,
    },
    ip: auth.ip,
  });

  return NextResponse.json({
    id,
    deleted: true,
    erasedDeploymentCount: erasure.deploymentIds.length,
    releasedPorts: erasure.releasedPorts,
  });
});
