import { NextResponse } from 'next/server';
import { listAccountSessions } from '@/lib/account-sessions';
import { apiRoute } from '@/lib/http';
import { requireSession } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The caller's open sessions. No RBAC permission: one only reads one's own, as
 * for the password and the second factor. The session token is never returned.
 */
export const GET = apiRoute(async (request) => {
  await requireSession(request);
  const { sessions } = await listAccountSessions(request.headers);
  return NextResponse.json({ items: sessions });
});
