import { findingQuerySchema, getScanRun, listFindings } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { deployments as messages } from '@/i18n/messages/deployments';
import { NotFoundError, msg } from '@/lib/errors';
import { apiRoute, readSearchParams } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

/** Détail d'une exécution : findings paginés, filtrables par sévérité. */
export const GET = apiRoute<Context>(async (request, context) => {
  await requirePermission(request, 'scan:read');
  const { id } = paramsSchema.parse(await context.params);
  const query = readSearchParams(request, findingQuerySchema);

  const run = await getScanRun(id);
  if (!run) throw new NotFoundError(msg(messages, 'error.scanNotFound', { id }));

  return NextResponse.json({ ...run, findings: await listFindings(id, query) });
});
