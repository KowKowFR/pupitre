import { NextResponse } from 'next/server';
import { visibleForecasts } from '@/lib/forecasts';
import { apiRoute } from '@/lib/http';
import { requireSession } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The current forecasts — what will break if nothing changes —, put into
 * sentences in the instance's language. Each one is only returned to whoever can
 * read its subject (`target:read`, `monitor:read`, `application:read`): a session
 * that does not see the probes does not see their forecasts.
 */
export const GET = apiRoute(async (request) => {
  const auth = await requireSession(request);
  return NextResponse.json({ items: await visibleForecasts(auth) });
});
