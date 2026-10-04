import { listSupervisedApps } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The running applications — not the deployments' history. One per
 * (application, target) pair: it is each pair's last deployment that really
 * runs.
 */
export const GET = apiRoute(async (request) => {
  await requirePermission(request, 'deployment:read');
  const items = await listSupervisedApps();
  return NextResponse.json({ items, total: items.length });
});
