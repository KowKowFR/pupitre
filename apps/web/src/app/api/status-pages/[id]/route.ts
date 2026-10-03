import { statusPagePath, updateStatusPageSchema } from '@pupitre/core';
import {
  StatusPageSlugTakenError,
  deleteStatusPage,
  getStatusPage,
  logAudit,
  updateStatusPage,
} from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { statusPages as messages } from '@/i18n/messages/status-pages';
import { ConflictError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { assertStatusMonitors, statusPageAuditSummary, statusPageJson } from '@/lib/status-page';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

async function load(id: string) {
  const row = await getStatusPage(id);
  if (!row) throw new NotFoundError(msg(messages, 'error.notFound'));
  return row;
}

export const GET = apiRoute<Context>(async (request, context) => {
  await requirePermission(request, 'status_page:manage');
  const { id } = paramsSchema.parse(await context.params);
  return NextResponse.json(statusPageJson(await load(id)));
});

export const PATCH = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'status_page:manage');
  const { id } = paramsSchema.parse(await context.params);
  const patch = await readJsonBody(request, updateStatusPageSchema);
  const current = await load(id);
  if (patch.blocks) await assertStatusMonitors(patch.blocks);
  const row = await updateStatusPage(id, patch).catch((error: unknown) => {
    if (error instanceof StatusPageSlugTakenError) {
      throw new ConflictError(
        msg(messages, 'error.slugTaken', { path: statusPagePath(patch.slug ?? current.slug) }),
      );
    }
    throw error;
  });
  if (!row) throw new NotFoundError(msg(messages, 'error.notFound'));
  await logAudit({
    actorId: auth.userId,
    action: 'status_page.updated',
    resourceType: 'status_page',
    resourceId: id,
    before: statusPageAuditSummary(current),
    after: statusPageAuditSummary(row),
    ip: auth.ip,
  });
  return NextResponse.json(statusPageJson(row));
});

export const DELETE = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'status_page:manage');
  const { id } = paramsSchema.parse(await context.params);
  const current = await load(id);
  await deleteStatusPage(id);
  await logAudit({
    actorId: auth.userId,
    action: 'status_page.deleted',
    resourceType: 'status_page',
    resourceId: id,
    before: statusPageAuditSummary(current),
    ip: auth.ip,
  });
  return new NextResponse(null, { status: 204 });
});
