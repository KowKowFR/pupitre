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
import { HttpError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

export const GET = apiRoute<Context>(async (request, context) => {
  await requirePermission(request, 'application:read');
  const { id } = paramsSchema.parse(await context.params);

  const application = await getApplication(id);
  if (!application) throw new NotFoundError(msg(messages, 'error.notFound', { id }));
  return NextResponse.json(application);
});

const patchSchema = z.object({
  description: z.string().max(500).optional(),
  appSpec: appSpecSchema.optional(),
  /** Une AppSpec régénérée remplace aussi la provenance conservée. */
  generation: generationOriginSchema.optional(),
});

export const PATCH = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'application:update');
  const { id } = paramsSchema.parse(await context.params);
  const patch = await readJsonBody(request, patchSchema);

  const before = await getApplication(id);
  if (!before) throw new NotFoundError(msg(messages, 'error.notFound', { id }));

  const after = await updateApplication(id, patch);
  if (!after) throw new NotFoundError(msg(messages, 'error.notFound', { id }));

  // Une AppSpec qui déclare un secret de plus le voit créé ici. Un secret
  // qu'elle retire n'est PAS supprimé : sa valeur sert peut-être encore à un
  // volume en service — voir `syncApplicationSecrets()`.
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

  // Ce qui bloque, ce n'est pas « porter des déploiements » — un déploiement
  // `destroyed` est un enregistrement d'historique, il ne retient rien. C'est
  // d'en porter un que le panel ne doit pas perdre de vue. La règle et son
  // vocabulaire sont ceux de la purge : `listApplicationDeletionBlockers()`.
  const blockers = await listApplicationDeletionBlockers(id);
  if (blockers.length > 0) {
    // La liste s'insère DANS la phrase : elle ne peut pas attendre la
    // sérialisation comme le fait `msg()`. On lit donc la langue ici, et les
    // deux morceaux tombent d'accord.
    const language = await currentLanguage();
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

  // Aucune poignée à perdre : l'historique restant n'est que de l'historique.
  // `eraseApplication()` l'efface et **rend les ports** dans la même
  // transaction, en disant lesquels — la cascade de clés étrangères le ferait
  // aussi, mais en silence, et le journal n'aurait rien à raconter.
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
