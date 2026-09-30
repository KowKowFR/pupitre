import { NextResponse } from 'next/server';
import { listAccountSessions } from '@/lib/account-sessions';
import { apiRoute } from '@/lib/http';
import { requireSession } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Les sessions ouvertes de l'appelant. Aucune permission RBAC : on ne lit que
 * les siennes, comme pour le mot de passe et le second facteur. Le jeton de
 * session n'est jamais renvoyé.
 */
export const GET = apiRoute(async (request) => {
  await requireSession(request);
  const { sessions } = await listAccountSessions(request.headers);
  return NextResponse.json({ items: sessions });
});
