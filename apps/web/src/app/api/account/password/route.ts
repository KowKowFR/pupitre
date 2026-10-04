import { logAudit } from '@pupitre/db';
import { z } from 'zod';
import { account as messages } from '@/i18n/messages/account';
import { getAuth } from '@/lib/auth';
import { HttpError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { PASSWORD_MIN_LENGTH } from '@/lib/password-policy';
import { requireSession } from '@/lib/rbac';
import { assertBetterAuthOk, withAuthCookies } from '../better-auth-call';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A password change by its owner.
 *
 * No RBAC permission: acting on one's own account is not a privilege.
 * `requireSession()` is enough — and `currentPassword` is required, otherwise a
 * stolen cookie would be enough to take over the account for good.
 */
const bodySchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(PASSWORD_MIN_LENGTH),
});

export const POST = apiRoute(async (request) => {
  const auth = await requireSession(request);
  const body = await readJsonBody(request, bodySchema);

  const response = await getAuth().api.changePassword({
    body: {
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
      // All the other sessions go down. A password one changes is a password one
      // assumes compromised: leaving the already stolen sessions open would empty the
      // operation of its point. Better Auth issues a new cookie for the caller,
      // relayed below.
      revokeOtherSessions: true,
    },
    headers: request.headers,
    asResponse: true,
  });

  try {
    await assertBetterAuthOk(response, msg(messages, 'error.passwordChangeRejected'));
  } catch (error) {
    await logAudit({
      actorId: auth.userId,
      action: 'account.password.change_failed',
      resourceType: 'user',
      resourceId: auth.userId,
      after: { reason: error instanceof HttpError ? error.code : 'unknown' },
      ip: auth.ip,
    });
    throw error;
  }

  // No password in the log — neither the old one, nor the new one, nor their
  // length: only the fact that the operation took place is traceable.
  await logAudit({
    actorId: auth.userId,
    action: 'account.password.changed',
    resourceType: 'user',
    resourceId: auth.userId,
    after: { revokedOtherSessions: true },
    ip: auth.ip,
  });

  return withAuthCookies({ ok: true, revokedOtherSessions: true }, response);
});
