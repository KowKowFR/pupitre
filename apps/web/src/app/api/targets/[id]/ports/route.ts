import { getTarget, getTargetPortReport } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { targets as messages } from '@/i18n/messages/targets';
import { NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

/**
 * The state of a target's port allocation: who occupies what, and what is left.
 *
 * Read-only and derived: nothing is stored here that `port_allocations` does not
 * already say. The route exists because the question "who took this port?" has no
 * obvious answer when one only looks at the table.
 */
export const GET = apiRoute<Context>(async (request, context) => {
  await requirePermission(request, 'target:read');
  const { id } = paramsSchema.parse(await context.params);

  const target = await getTarget(id);
  if (!target) throw new NotFoundError(msg(messages, 'error.notFound', { id }));

  const report = await getTargetPortReport(id);
  if (!report) throw new NotFoundError(msg(messages, 'error.notFound', { id }));

  return NextResponse.json(report);
});
