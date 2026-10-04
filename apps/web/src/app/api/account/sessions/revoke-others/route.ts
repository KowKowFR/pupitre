import { logAudit } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { listAccountSessions } from '@/lib/account-sessions';
import { getAuth } from '@/lib/auth';
import { apiRoute } from '@/lib/http';
import { requireSession } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Closes all the caller's sessions **except** the request's. The other devices
 * go back to the sign-in screen at their next call.
 *
 * The count is taken before closing: it tells the log how many devices were
 * signed out, and it allows writing nothing when there was nothing to close.
 */
export const POST = apiRoute(async (request) => {
  const auth = await requireSession(request);

  const { sessions } = await listAccountSessions(request.headers);
  const others = sessions.filter((session) => !session.current);
  if (others.length === 0) return NextResponse.json({ revoked: 0 });

  await getAuth().api.revokeOtherSessions({ headers: request.headers });

  await logAudit({
    actorId: auth.userId,
    action: 'account.sessions.revoked_others',
    resourceType: 'user',
    resourceId: auth.userId,
    before: {
      sessions: others.map((session) => ({ device: session.device, ip: session.ipAddress })),
    },
    after: { revoked: others.length },
    ip: auth.ip,
  });

  return NextResponse.json({ revoked: others.length });
});
