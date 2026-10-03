import { NextResponse } from 'next/server';
import { visibleForecasts } from '@/lib/forecasts';
import { apiRoute } from '@/lib/http';
import { requireSession } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Les prévisions en cours — ce qui va casser si rien ne change —, mises en
 * phrases dans la langue de l'instance. Chacune n'est rendue qu'à qui peut
 * lire son sujet (`target:read`, `monitor:read`, `application:read`) : une
 * session qui ne voit pas les sondes ne voit pas leurs prévisions.
 */
export const GET = apiRoute(async (request) => {
  const auth = await requireSession(request);
  return NextResponse.json({ items: await visibleForecasts(auth) });
});
