import { auditQuerySchema, listAuditLogs } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { apiRoute, readSearchParams } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Journal d'audit paginé.
 * Filtres : `actorId`, `action`, `resourceType`, `from`, `to` (ISO 8601).
 */
export const GET = apiRoute(async (request) => {
  await requirePermission(request, 'audit:read');
  const query = readSearchParams(request, auditQuerySchema);
  return NextResponse.json(await listAuditLogs(query));
});
