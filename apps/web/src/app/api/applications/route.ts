import { ENV_NAME_PATTERN, appSpecSchema } from '@pupitre/core';
import { generationOriginSchema, listApplications, secretValueSchema } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createApplicationFromSpec } from '@/lib/application-create';
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
  /** L'AppSpec vient d'un docker-compose.yml traduit par `import-compose`. */
  importedFrom: z.literal('compose').optional(),
  /**
   * Valeurs choisies dès la création, pour les secrets que la spec déclare :
   * une clé d'API, un mot de passe déjà en service ailleurs. Les autres sont
   * générées. Un nom absent de la spec — ou un alias, qui n'a pas de valeur à
   * lui — est refusé : il n'y aurait rien à quoi l'attacher.
   */
  secrets: z.record(z.string().regex(ENV_NAME_PATTERN), secretValueSchema.min(1)).default({}),
});

export const POST = apiRoute(async (request) => {
  const auth = await requirePermission(request, 'application:create');
  const input = await readJsonBody(request, bodySchema);
  const application = await createApplicationFromSpec({
    appSpec: input.appSpec,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.generation !== undefined ? { generation: input.generation } : {}),
    origin: input.importedFrom ?? 'manual',
    secrets: input.secrets,
    actorId: auth.userId,
    ip: auth.ip,
  });

  return NextResponse.json(application, { status: 201 });
});
