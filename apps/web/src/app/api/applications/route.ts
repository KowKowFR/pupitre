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
 * The body is an AppSpec. The slug is derived from it — `appSpec.name` is the
 * only source of truth for the name, there is no competing field to reconcile.
 */
const bodySchema = z.object({
  description: z.string().max(500).optional(),
  appSpec: appSpecSchema,
  /**
   * Provenance, when the AppSpec comes from `POST /api/applications/generate`. We
   * store the prompt and the **generated** spec, not only the validated spec: that
   * is what allows reviewing what was corrected by hand.
   */
  generation: generationOriginSchema.optional(),
  /** L'AppSpec vient d'un docker-compose.yml traduit par `import-compose`. */
  importedFrom: z.literal('compose').optional(),
  /**
   * Values chosen from creation, for the secrets the spec declares: an API key, a
   * password already in service elsewhere. The others are generated. A name absent
   * from the spec — or an alias, which has no value of its own — is refused: there
   * would be nothing to attach it to.
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
