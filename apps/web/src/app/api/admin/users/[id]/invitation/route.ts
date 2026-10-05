import { eq, getDb, logAudit, users } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { mailChannelName } from '@/lib/account-mail';
import { hasPassword, revokeResetTokens } from '@/lib/auth';
import { admin } from '@/i18n/messages/admin';
import { ConflictError, HttpError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { inviteExistingUser } from '../../route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().min(1).max(200) });

type Context = { params: Promise<{ id: string }> };

/**
 * Resending an invitation.
 *
 * The common case: the link expired, or the message got lost. Without this
 * button, the only way out would be to delete the account and create it again —
 * making it lose its role and its place in the log.
 *
 * **The previous links die first.** That is the non-negotiable part: two live
 * links for the same account is a link one believes cancelled and that still
 * opens the door. Better Auth does not invalidate earlier tokens when it creates
 * a new one — it is up to us to do it.
 */
export const POST = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'user:manage');
  const { id } = paramsSchema.parse(await context.params);

  const db = getDb();
  const [target] = await db.select().from(users).where(eq(users.id, id));
  if (!target) throw new NotFoundError(msg(admin, 'error.user.notFound', { id }));

  if (await hasPassword(id)) {
    // The account is active: the person already chose their password. Sending them
    // an "invitation" again would be a disguised reset, decided by someone other
    // than them. If they are stuck, it is up to them to ask for a reset from the
    // sign-in screen.
    throw new ConflictError(msg(admin, 'error.user.hasPassword', { email: target.email }));
  }

  if (target.banned) {
    throw new ConflictError(msg(admin, 'error.user.banned', { email: target.email }));
  }

  if (!(await mailChannelName())) {
    throw new HttpError(409, 'mail_channel_missing', msg(admin, 'error.mail.missing.resend'));
  }

  const revoked = await revokeResetTokens(id);

  const invitation = await inviteExistingUser({
    userId: id,
    email: target.email,
    actorId: auth.userId,
    actorEmail: auth.email,
    ip: auth.ip,
    headers: request.headers,
    resend: true,
  });

  return NextResponse.json({ id, revokedLinks: revoked, invitation });
});

/**
 * Cancelling an invitation: the current links die, the account stays.
 *
 * Two distinct gestures, as "destroy" and "purge" are for a deployment. This one
 * closes the door without erasing the person — useful when the address was
 * wrong, or when the arrival is postponed. To erase the account, it is
 * `DELETE /api/admin/users/{id}`.
 */
export const DELETE = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'user:manage');
  const { id } = paramsSchema.parse(await context.params);

  const db = getDb();
  const [target] = await db.select().from(users).where(eq(users.id, id));
  if (!target) throw new NotFoundError(msg(admin, 'error.user.notFound', { id }));

  const revoked = await revokeResetTokens(id);
  if (revoked === 0) {
    throw new ConflictError(msg(admin, 'error.invitation.none', { email: target.email }));
  }

  await logAudit({
    actorId: auth.userId,
    action: 'user.invitation.revoked',
    resourceType: 'user',
    resourceId: id,
    after: { email: target.email, revokedLinks: revoked },
    ip: auth.ip,
  });

  return NextResponse.json({ id, revokedLinks: revoked });
});
