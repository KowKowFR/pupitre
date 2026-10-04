import { auditSeverityOf } from '@pupitre/core';
import { auditQuerySchema, getAppSettings, listAuditLogs } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { expandDayRange } from '@/lib/day-range';
import { apiRoute, searchParamsOf } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The paginated audit log. Filters: `q` (free search), `severity`
 * (`high,critical`), `actorId`, `action`, `resourceType`, `from`, `to` — an ISO
 * 8601 instant, or a day (`2026-09-30`) read in the instance's time zone, `to`
 * then covering the whole day.
 */
export const GET = apiRoute(async (request) => {
  await requirePermission(request, 'audit:read');
  const { settings } = await getAppSettings();
  const query = auditQuerySchema.parse(expandDayRange(searchParamsOf(request), settings.timezone));
  const page = await listAuditLogs(query);
  // The severity is a reading of the action, not a column: it is computed here,
  // with the same table as the screen and the filter.
  return NextResponse.json({
    ...page,
    items: page.items.map((item) => ({ ...item, severity: auditSeverityOf(item.action) })),
  });
});
