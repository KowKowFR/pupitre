import { listApiTokens } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { toApiTokenDto } from '@/lib/api-tokens';
import { apiRoute } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * All the instance's API tokens, with their author — to know what can act
 * without a browser, and cut it off. From the panel only.
 */
export const GET = apiRoute(async (request) => {
  await requirePermission(request, 'user:read', { sessionOnly: true });
  const items = await listApiTokens();
  return NextResponse.json({ items: items.map(toApiTokenDto) });
});
