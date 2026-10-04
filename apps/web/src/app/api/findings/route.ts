import { globalFindingQuerySchema, listAllFindings } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { apiRoute, readSearchParams } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A cross-cutting view of the vulnerabilities. Filters: `cveId`, `severity`,
 * `applicationId`, `deploymentId`, `scanner`.
 */
export const GET = apiRoute(async (request) => {
  await requirePermission(request, 'scan:read');
  const query = readSearchParams(request, globalFindingQuerySchema);
  return NextResponse.json(await listAllFindings(query));
});
