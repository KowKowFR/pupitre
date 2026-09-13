import { getApplication, listApplicationSecrets } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { buildSecretViews } from '@/lib/application-secrets';
import { applications as messages } from '@/i18n/messages/applications';
import { NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

/** État des secrets d'une application. Jamais leurs valeurs. */
export const GET = apiRoute<Context>(async (request, context) => {
  await requirePermission(request, 'application:read');
  const { id } = paramsSchema.parse(await context.params);

  const application = await getApplication(id);
  if (!application) throw new NotFoundError(msg(messages, 'error.notFound', { id }));

  const stored = await listApplicationSecrets(id);
  const items = buildSecretViews(application.appSpec, stored);
  return NextResponse.json({ items, total: items.length });
});
