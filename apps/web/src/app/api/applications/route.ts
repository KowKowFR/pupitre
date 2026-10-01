import { ENV_NAME_PATTERN, appSpecSchema, storedSecretNames } from '@pupitre/core';
import {
  createApplication,
  secretValueSchema,
  setApplicationSecret,
  generationOriginSchema,
  getApplicationBySlug,
  listApplications,
  logAudit,
  syncApplicationSecrets,
} from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { applications as messages } from '@/i18n/messages/applications';
import { ConflictError, msg } from '@/lib/errors';
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

  const storable = storedSecretNames(input.appSpec);
  for (const name of Object.keys(input.secrets)) {
    if (!storable.includes(name)) {
      throw new ConflictError(msg(messages, 'error.secretNotDeclared', { name }));
    }
  }

  const existing = await getApplicationBySlug(input.appSpec.name);
  if (existing) {
    throw new ConflictError(msg(messages, 'error.slugTaken', { name: input.appSpec.name }));
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
  // Puis celles qu'on a choisies remplacent les valeurs tirées au sort.
  for (const [name, value] of Object.entries(input.secrets)) {
    await setApplicationSecret(application.id, name, value, 'provided');
  }

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
        : { origin: input.importedFrom ?? 'manual' }),
      // Les noms, jamais les valeurs.
      secretsGenerated: generated.filter((name) => !(name in input.secrets)),
      secretsProvided: Object.keys(input.secrets),
    },
    ip: auth.ip,
  });

  return NextResponse.json(application, { status: 201 });
});
