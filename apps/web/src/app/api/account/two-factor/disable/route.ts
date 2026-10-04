import { logAudit } from '@pupitre/db';
import { z } from 'zod';
import { account as messages } from '@/i18n/messages/account';
import { errors } from '@/i18n/messages/errors';
import { getAuth } from '@/lib/auth';
import { HttpError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requireSession } from '@/lib/rbac';
import { assertBetterAuthOk, withAuthCookies } from '../../better-auth-call';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The password is required: removing a factor is as sensitive as adding it. */
const bodySchema = z.object({ password: z.string().min(1) });

export const POST = apiRoute(async (request) => {
  const auth = await requireSession(request);
  const body = await readJsonBody(request, bodySchema);

  // The role requires it: removing it would immediately reopen the obligation to
  // set it again. A lost device is dealt with through the reset, which an
  // administrator performs (`user:reset-2fa`).
  if (auth.twoFactor.required) {
    await logAudit({
      actorId: auth.userId,
      action: 'account.2fa.disable_failed',
      resourceType: 'user',
      resourceId: auth.userId,
      after: { reason: 'two_factor_locked' },
      ip: auth.ip,
    });
    throw new HttpError(409, 'two_factor_locked', msg(errors, 'two_factor_locked'));
  }

  const response = await getAuth().api.disableTwoFactor({
    body: { password: body.password },
    headers: request.headers,
    asResponse: true,
  });

  try {
    await assertBetterAuthOk(response, msg(messages, 'error.disableRejected'));
  } catch (error) {
    await logAudit({
      actorId: auth.userId,
      action: 'account.2fa.disable_failed',
      resourceType: 'user',
      resourceId: auth.userId,
      after: { reason: error instanceof HttpError ? error.code : 'unknown' },
      ip: auth.ip,
    });
    throw error;
  }

  await logAudit({
    actorId: auth.userId,
    action: 'account.2fa.disabled',
    resourceType: 'user',
    resourceId: auth.userId,
    after: { method: 'totp' },
    ip: auth.ip,
  });

  return withAuthCookies({ ok: true, twoFactorEnabled: false }, response);
});
