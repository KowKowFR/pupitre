import { appSpecSchema } from '@pupitre/core';
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
import { HttpError, NotFoundError } from '@/lib/errors';
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
  if (!application) throw new NotFoundError(`Application « ${id} » introuvable`);
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
  if (!before) throw new NotFoundError(`Application « ${id} » introuvable`);

  const after = await updateApplication(id, patch);
  if (!after) throw new NotFoundError(`Application « ${id} » introuvable`);

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
  if (!application) throw new NotFoundError(`Application « ${id} » introuvable`);

  // Ce qui bloque, ce n'est pas « porter des déploiements » — un déploiement
  // `destroyed` est un enregistrement d'historique, il ne retient rien. C'est
  // d'en porter un que le panel ne doit pas perdre de vue. La règle et son
  // vocabulaire sont ceux de la purge : `listApplicationDeletionBlockers()`.
  const blockers = await listApplicationDeletionBlockers(id);
  if (blockers.length > 0) {
    throw new HttpError(
      409,
      'application_has_live_deployments',
      `« ${application.slug} » a ${blockers.length} déploiement(s) encore en place : ` +
        `${blockers.map((blocker) => `v${blocker.version} sur ${blocker.targetName}`).join(', ')}. ` +
        `Supprimez-la en cascade (POST ${new URL(request.url).pathname}/cascade) — elle les ` +
        `détruira sur leurs cibles avant d'effacer l'application —, ou détruisez-les d'abord.`,
      { blockers },
    );
  }

  // Aucune poignée à perdre : l'historique restant n'est que de l'historique.
  // `eraseApplication()` l'efface et **rend les ports** dans la même
  // transaction, en disant lesquels — la cascade de clés étrangères le ferait
  // aussi, mais en silence, et le journal n'aurait rien à raconter.
  const erasure = await eraseApplication(id);
  if (!erasure) throw new NotFoundError(`Application « ${id} » introuvable`);

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
