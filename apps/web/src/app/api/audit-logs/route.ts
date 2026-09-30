import { auditQuerySchema, getAppSettings, listAuditLogs } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { expandDayRange } from '@/lib/day-range';
import { apiRoute, searchParamsOf } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Journal d'audit paginé.
 * Filtres : `actorId`, `action`, `resourceType`, `from`, `to` — un instant
 * ISO 8601, ou un jour (`2026-09-30`) lu dans le fuseau de l'instance, `to`
 * couvrant alors la journée entière.
 */
export const GET = apiRoute(async (request) => {
  await requirePermission(request, 'audit:read');
  const { settings } = await getAppSettings();
  const query = auditQuerySchema.parse(expandDayRange(searchParamsOf(request), settings.timezone));
  return NextResponse.json(await listAuditLogs(query));
});
