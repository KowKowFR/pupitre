import {
  UserNotFoundError,
  eq,
  getDb,
  logAudit,
  resetUserTwoFactor,
  users,
} from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSession } from '@/lib/auth';
import { admin } from '@/i18n/messages/admin';
import { ConflictError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().min(1).max(200) });

type Context = { params: Promise<{ id: string }> };

/**
 * Resetting another user's second factor — the way out for someone who lost
 * their phone AND their backup codes.
 *
 * `user:reset-2fa`, and not `user:manage`: the gesture lifts a protection on an
 * account, it is not given together with the right to change a role.
 *
 * On sessions, the rule is the password change's (`revokeOtherSessions`): all of
 * the target's go down. The request comes when a device was lost or stolen;
 * letting the session open on that device live would empty the operation of its
 * meaning. The only exception, the caller's session when they reset themselves:
 * closing it would send them back to the sign-in screen without protecting
 * anything more.
 */
export const DELETE = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'user:reset-2fa');
  const { id } = paramsSchema.parse(await context.params);

  const db = getDb();
  const [target] = await db.select().from(users).where(eq(users.id, id));
  if (!target) throw new NotFoundError(msg(admin, 'error.user.notFound', { id }));

  // Resetting oneself is allowed: an administrator who lost their phone but still
  // holds a session is exactly the one we do not want to force to open an SQL
  // client. They gain no access they did not already have, and the audit keeps the
  // trace that the actor and the target are one and the same.
  const isSelf = id === auth.userId;
  const session = isSelf ? await getSession(request.headers) : null;

  const outcome = await resetUserTwoFactor(
    id,
    { keepSessionId: session?.session.id ?? null },
    db,
  ).catch((error: unknown) => {
    if (error instanceof UserNotFoundError) {
      throw new NotFoundError(msg(admin, 'error.user.notFound', { id }));
    }
    throw error;
  });

  if (outcome.stateBefore === 'none') {
    throw new ConflictError(msg(admin, 'error.user.no2fa', { email: target.email }));
  }

  // Nothing secret here: neither the old TOTP secret, nor the backup codes, which
  // never left the database other than encrypted anyway. We trace who acted, on
  // whom, from which IP, and what the operation took away.
  await logAudit({
    actorId: auth.userId,
    action: 'user.2fa.reset',
    resourceType: 'user',
    resourceId: id,
    before: { twoFactor: outcome.stateBefore },
    after: {
      email: target.email,
      name: target.name,
      self: isSelf,
      twoFactor: 'none',
      removedFactors: outcome.removedFactors,
      revokedSessions: outcome.revokedSessions,
      revokedTrustedDevices: outcome.revokedTrustedDevices,
    },
    ip: auth.ip,
  });

  return NextResponse.json({
    id,
    twoFactor: 'none',
    twoFactorEnabled: false,
    revokedSessions: outcome.revokedSessions,
    revokedTrustedDevices: outcome.revokedTrustedDevices,
  });
});
