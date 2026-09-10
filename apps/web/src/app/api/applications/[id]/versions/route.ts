import { getApplication, listApplicationVersions } from '@tp/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

/**
 * Historique des versions déployées d'une application.
 *
 * Il n'y a pas de table « versions » : le déploiement *est* la version, et son
 * `app_spec` figée est ce qui rend un redéploiement possible longtemps après,
 * même si l'application a changé depuis.
 */
export const GET = apiRoute<Context>(async (request, context) => {
  await requirePermission(request, 'application:read');
  const { id } = paramsSchema.parse(await context.params);

  const application = await getApplication(id);
  if (!application) throw new NotFoundError(`Application « ${id} » introuvable`);

  const items = await listApplicationVersions(id);

  return NextResponse.json({
    applicationId: id,
    applicationSlug: application.slug,
    items,
    total: items.length,
  });
});
