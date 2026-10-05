import { logAudit } from '@pupitre/db';
import { z } from 'zod';
import { account as messages } from '@/i18n/messages/account';
import { getAuth } from '@/lib/auth';
import { HttpError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requireSession } from '@/lib/rbac';
import { assertBetterAuthOk, withAuthCookies } from '../../better-auth-call';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({ code: z.string().regex(/^\d{6}$/) });

/**
 * The second half of the activation: a first code must be valid before the
 * second factor is really armed. Without this step, a user whose authenticator
 * app is badly set would find themselves locked out at the next sign-in.
 *
 * Better Auth rotates the session cookie when marking `twoFactorEnabled`: the
 * response relays its `Set-Cookie`s.
 */
export const POST = apiRoute(async (request) => {
  const auth = await requireSession(request);
  const body = await readJsonBody(request, bodySchema);

  const response = await getAuth().api.verifyTOTP({
    body: { code: body.code, trustDevice: false },
    headers: request.headers,
    asResponse: true,
  });

  try {
    await assertBetterAuthOk(response, msg(messages, 'error.codeRejected'));
  } catch (error) {
    await logAudit({
      actorId: auth.userId,
      action: 'account.2fa.activation_failed',
      resourceType: 'user',
      resourceId: auth.userId,
      after: { reason: error instanceof HttpError ? error.code : 'unknown' },
      ip: auth.ip,
    });
    throw error;
  }

  await logAudit({
    actorId: auth.userId,
    action: 'account.2fa.enabled',
    resourceType: 'user',
    resourceId: auth.userId,
    after: { method: 'totp' },
    ip: auth.ip,
  });

  return withAuthCookies({ ok: true, twoFactorEnabled: true }, response);
});
