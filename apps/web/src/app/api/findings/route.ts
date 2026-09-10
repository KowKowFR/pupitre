import { globalFindingQuerySchema, listAllFindings } from '@tp/db';
import { NextResponse } from 'next/server';
import { apiRoute, readSearchParams } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Vue transverse des vulnérabilités.
 * Filtres : `cveId`, `severity`, `applicationId`, `deploymentId`, `scanner`.
 */
export const GET = apiRoute(async (request) => {
  await requirePermission(request, 'scan:read');
  const query = readSearchParams(request, globalFindingQuerySchema);
  return NextResponse.json(await listAllFindings(query));
});
