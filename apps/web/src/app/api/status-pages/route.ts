import { statusPageInputSchema, statusPagePath } from '@pupitre/core';
import { StatusPageSlugTakenError, createStatusPage, listStatusPages, logAudit } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { statusPages as messages } from '@/i18n/messages/status-pages';
import { ConflictError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { assertStatusMonitors, statusPageAuditSummary, statusPageJson } from '@/lib/status-page';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Les pages de statut, publiées ou non. Les composer est un droit d'administration. */
export const GET = apiRoute(async (request) => {
  await requirePermission(request, 'status_page:manage');
  const pages = await listStatusPages();
  return NextResponse.json({ items: pages.map(statusPageJson) });
});

export const POST = apiRoute(async (request) => {
  const auth = await requirePermission(request, 'status_page:manage');
  const input = await readJsonBody(request, statusPageInputSchema);
  await assertStatusMonitors(input.blocks);
  const row = await createStatusPage(input, auth.userId).catch((error: unknown) => {
    if (error instanceof StatusPageSlugTakenError) {
      throw new ConflictError(
        msg(messages, 'error.slugTaken', { path: statusPagePath(input.slug) }),
      );
    }
    throw error;
  });
  await logAudit({
    actorId: auth.userId,
    action: 'status_page.created',
    resourceType: 'status_page',
    resourceId: row.id,
    after: statusPageAuditSummary(row),
    ip: auth.ip,
  });
  return NextResponse.json(statusPageJson(row), { status: 201 });
});
