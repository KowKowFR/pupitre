import { isStatusUpdatePhaseFor, updateStatusUpdateSchema } from '@pupitre/core';
import {
  deleteStatusUpdate,
  getStatusUpdate,
  logAudit,
  statusUpdateSubjectOf,
  updateStatusUpdate,
} from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { statusPages as messages } from '@/i18n/messages/status-pages';
import { HttpError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { statusUpdateAuditSummary, statusUpdateJson } from '@/lib/status-updates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

async function load(id: string) {
  const row = await getStatusUpdate(id);
  if (!row) throw new NotFoundError(msg(messages, 'error.announce.notFound'));
  return row;
}

/** Correcting an announcement: its phase or its text. Its publication time does not change. */
export const PATCH = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'status_page:announce');
  const { id } = paramsSchema.parse(await context.params);
  const patch = await readJsonBody(request, updateStatusUpdateSchema);
  const current = await load(id);
  if (patch.phase && !isStatusUpdatePhaseFor(statusUpdateSubjectOf(current).type, patch.phase)) {
    throw new HttpError(422, 'phase_mismatch', msg(messages, 'error.announce.phase'));
  }
  const row = await updateStatusUpdate(id, patch);
  if (!row) throw new NotFoundError(msg(messages, 'error.announce.notFound'));
  await logAudit({
    actorId: auth.userId,
    action: 'status_update.updated',
    resourceType: 'status_update',
    resourceId: id,
    before: statusUpdateAuditSummary(current),
    after: statusUpdateAuditSummary(row),
    ip: auth.ip,
  });
  return NextResponse.json(statusUpdateJson(row));
});

export const DELETE = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'status_page:announce');
  const { id } = paramsSchema.parse(await context.params);
  const current = await load(id);
  await deleteStatusUpdate(id);
  await logAudit({
    actorId: auth.userId,
    action: 'status_update.deleted',
    resourceType: 'status_update',
    resourceId: id,
    before: statusUpdateAuditSummary(current),
    ip: auth.ip,
  });
  return new NextResponse(null, { status: 204 });
});
