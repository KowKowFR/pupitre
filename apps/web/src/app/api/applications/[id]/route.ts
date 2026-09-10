import { appSpecSchema } from '@tp/core';
import {
  countDeploymentsFor,
  deleteApplication,
  generationOriginSchema,
  getApplication,
  logAudit,
  updateApplication,
} from '@tp/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ConflictError, NotFoundError } from '@/lib/errors';
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

  const deploymentCount = await countDeploymentsFor(id);
  if (deploymentCount > 0) {
    throw new ConflictError(
      `Cette application porte ${deploymentCount} déploiement(s). Détruisez-les d'abord.`,
    );
  }

  await deleteApplication(id);

  await logAudit({
    actorId: auth.userId,
    action: 'application.deleted',
    resourceType: 'application',
    resourceId: id,
    before: { slug: application.slug },
    ip: auth.ip,
  });

  return NextResponse.json({ id, deleted: true });
});
