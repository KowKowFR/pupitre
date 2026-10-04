import { NextResponse } from 'next/server';
import { listDomains } from '@/lib/domains';
import { apiRoute } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * All the instance's domains: the proxy that serves them, their state, their
 * certificate and the time it has left. `attention` says those that do not answer
 * or whose certificate is nearing its expiry — enough to plug in an external
 * check without recomputing anything.
 */
export const GET = apiRoute(async (request) => {
  await requirePermission(request, 'application:read');
  return NextResponse.json({ items: await listDomains() });
});
