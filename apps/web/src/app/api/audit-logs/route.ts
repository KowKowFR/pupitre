import { auditSeverityOf } from '@pupitre/core';
import { auditQuerySchema, getAppSettings, listAuditLogs } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { expandDayRange } from '@/lib/day-range';
import { apiRoute, searchParamsOf } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Journal d'audit paginé.
 * Filtres : `q` (recherche libre), `severity` (`high,critical`), `actorId`,
 * `action`, `resourceType`, `from`, `to` — un instant ISO 8601, ou un jour
 * (`2026-09-30`) lu dans le fuseau de l'instance, `to` couvrant alors la
 * journée entière.
 */
export const GET = apiRoute(async (request) => {
  await requirePermission(request, 'audit:read');
  const { settings } = await getAppSettings();
  const query = auditQuerySchema.parse(expandDayRange(searchParamsOf(request), settings.timezone));
  const page = await listAuditLogs(query);
  // La criticité est une lecture de l'action, pas une colonne : elle se
  // calcule ici, avec la même table que l'écran et le filtre.
  return NextResponse.json({
    ...page,
    items: page.items.map((item) => ({ ...item, severity: auditSeverityOf(item.action) })),
  });
});
