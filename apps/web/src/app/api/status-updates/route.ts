import { createStatusUpdateSchema, parseStatusUpdateSubjectKey } from '@pupitre/core';
import { createStatusUpdate, listStatusUpdates, logAudit } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import {
  assertStatusUpdateSubject,
  statusUpdateAuditSummary,
  statusUpdateJson,
} from '@/lib/status-updates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  subject: z.string().transform((key, context) => {
    const subject = parseStatusUpdateSubjectKey(key);
    if (!subject) {
      context.addIssue({
        code: 'custom',
        message: 'sujet attendu : incident:<id> ou maintenance:<id>',
      });
      return z.NEVER;
    }
    return subject;
  }),
});

/** Les annonces d'un sujet (`?subject=incident:<id>`), des plus anciennes aux plus récentes. */
export const GET = apiRoute(async (request) => {
  await requirePermission(request, 'status_page:announce');
  const { subject } = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
  const rows = await listStatusUpdates(
    subject.type === 'incident' ? { incidentIds: [subject.id] } : { windowIds: [subject.id] },
  );
  return NextResponse.json({ items: rows.map((row) => statusUpdateJson(row, row.authorName)) });
});

/** Publier une annonce : elle paraît aussitôt sur les pages qui montrent une sonde touchée. */
export const POST = apiRoute(async (request) => {
  const auth = await requirePermission(request, 'status_page:announce');
  const input = await readJsonBody(request, createStatusUpdateSchema);
  await assertStatusUpdateSubject(input.subject);
  const row = await createStatusUpdate(input, auth.userId);
  await logAudit({
    actorId: auth.userId,
    action: 'status_update.created',
    resourceType: 'status_update',
    resourceId: row.id,
    after: statusUpdateAuditSummary(row),
    ip: auth.ip,
  });
  return NextResponse.json(statusUpdateJson(row, auth.name), { status: 201 });
});
