import { logAudit } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { account as messages } from '@/i18n/messages/account';
import { listAccountSessions } from '@/lib/account-sessions';
import { getAuth } from '@/lib/auth';
import { ConflictError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { requireSession } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().min(1).max(200) });
type Context = { params: Promise<{ id: string }> };

/**
 * Closes **one** other session of the caller — the computer left on at the
 * office, the lost phone.
 *
 * The lookup goes through the caller's list: a session that is not theirs is not
 * found, not forbidden, and the response says no more. One's own session is not
 * closed here: it is "Sign out", which also cleans the cookie.
 */
export const DELETE = apiRoute<Context>(async (request, context) => {
  const auth = await requireSession(request);
  const { id } = paramsSchema.parse(await context.params);

  const { sessions, tokens } = await listAccountSessions(request.headers);
  const session = sessions.find((entry) => entry.id === id);
  const token = tokens.get(id);
  if (!session || !token) throw new NotFoundError(msg(messages, 'error.session.notFound'));
  if (session.current) throw new ConflictError(msg(messages, 'error.session.current'));

  await getAuth().api.revokeSession({ body: { token }, headers: request.headers });

  await logAudit({
    actorId: auth.userId,
    action: 'account.session.revoked',
    resourceType: 'session',
    resourceId: id,
    before: { device: session.device, ip: session.ipAddress, createdAt: session.createdAt },
    ip: auth.ip,
  });

  return NextResponse.json({ ok: true });
});
