import { getApplication, listImageUpdates } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { applications as messages } from '@/i18n/messages/applications';
import { NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

/**
 * The last finding on the application's images, target by target: what runs,
 * what the registry announces, whether a more recent tag exists.
 */
export const GET = apiRoute<Context>(async (request, context) => {
  await requirePermission(request, 'application:read');
  const { id } = paramsSchema.parse(await context.params);

  const application = await getApplication(id);
  if (!application) throw new NotFoundError(msg(messages, 'error.notFound', { id }));

  const rows = await listImageUpdates(id);
  return NextResponse.json({
    items: rows.map((row) => ({
      targetId: row.targetId,
      targetName: row.targetName,
      deploymentId: row.deploymentId,
      service: row.service,
      image: row.image,
      status: row.status,
      runningDigest: row.runningDigest,
      latestDigest: row.latestDigest,
      newerTag: row.newerTag,
      nextMajorTag: row.nextMajorTag,
      error: row.error,
      checkedAt: row.checkedAt.toISOString(),
    })),
  });
});
