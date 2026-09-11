import { appSpecSchema } from '@tp/core';
import {
  createApplication,
  generationOriginSchema,
  getApplicationBySlug,
  listApplications,
  logAudit,
  syncApplicationSecrets,
} from '@tp/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ConflictError } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = apiRoute(async (request) => {
  await requirePermission(request, 'application:read');
  const items = await listApplications();
  return NextResponse.json({ items, total: items.length });
});

/**
 * Le corps est une AppSpec. Le slug en est déduit — `appSpec.name` est la seule
 * source de vérité pour le nom, il n'y a pas de champ concurrent à réconcilier.
 */
const bodySchema = z.object({
  description: z.string().max(500).optional(),
  appSpec: appSpecSchema,
  /**
   * Provenance, quand l'AppSpec vient de `POST /api/applications/generate`.
   * On enregistre le prompt et la spec **générée**, pas seulement la spec
   * validée : c'est ce qui permet de relire ce qui a été corrigé à la main.
   */
  generation: generationOriginSchema.optional(),
});

export const POST = apiRoute(async (request) => {
  const auth = await requirePermission(request, 'application:create');
  const input = await readJsonBody(request, bodySchema);

  const existing = await getApplicationBySlug(input.appSpec.name);
  if (existing) {
    throw new ConflictError(`Une application « ${input.appSpec.name} » existe déjà`);
  }

  const application = await createApplication({
    appSpec: input.appSpec,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.generation !== undefined ? { generation: input.generation } : {}),
    ownerId: auth.userId,
  });

  // Les secrets déclarés reçoivent tout de suite une valeur générée : un
  // déploiement ne doit jamais échouer parce que personne n'a pensé à les
  // renseigner. Une valeur venue de l'extérieur se pose ensuite, par PUT.
  const generated = await syncApplicationSecrets(application.id, input.appSpec);

  await logAudit({
    actorId: auth.userId,
    action: 'application.created',
    resourceType: 'application',
    resourceId: application.id,
    after: {
      slug: application.slug,
      version: input.appSpec.version,
      services: input.appSpec.services.map((service) => service.name),
      ...(input.generation
        ? {
            origin: 'ai',
            model: input.generation.model,
            prompt: input.generation.prompt,
            // Une spec acceptée telle quelle et une spec retouchée ne racontent
            // pas la même histoire : le journal doit les distinguer.
            edited:
              JSON.stringify(input.generation.appSpec) !== JSON.stringify(input.appSpec),
          }
        : { origin: 'manual' }),
      // Les noms, jamais les valeurs.
      secretsGenerated: generated,
    },
    ip: auth.ip,
  });

  return NextResponse.json(application, { status: 201 });
});
