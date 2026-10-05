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

const bodySchema = z.object({ password: z.string().min(1) });

/**
 * The first half of the activation: Better Auth generates a secret and backup
 * codes, but leaves the `two_factors` row at `verified = false`. The second
 * factor is not armed yet — it will be at `/activate`, once a valid code is
 * provided.
 *
 * It is the ONLY panel response that carries the TOTP secret and the backup
 * codes. They go through neither the audit log nor the logs.
 */
export const POST = apiRoute(async (request) => {
  const auth = await requireSession(request);
  const body = await readJsonBody(request, bodySchema);

  const response = await getAuth().api.enableTwoFactor({
    body: { password: body.password, method: 'totp' },
    headers: request.headers,
    asResponse: true,
  });

  try {
    await assertBetterAuthOk(response, msg(messages, 'error.setupRejected'));
  } catch (error) {
    await logAudit({
      actorId: auth.userId,
      action: 'account.2fa.setup_failed',
      resourceType: 'user',
      resourceId: auth.userId,
      after: { reason: error instanceof HttpError ? error.code : 'unknown' },
      ip: auth.ip,
    });
    throw error;
  }

  const payload = (await response.json()) as { totpURI?: unknown; backupCodes?: unknown };
  const totpURI = typeof payload.totpURI === 'string' ? payload.totpURI : null;
  const backupCodes = Array.isArray(payload.backupCodes)
    ? payload.backupCodes.filter((code): code is string => typeof code === 'string')
    : [];

  if (!totpURI) {
    throw new HttpError(502, 'totp_uri_missing', msg(messages, 'error.totpUriMissing'));
  }

  await logAudit({
    actorId: auth.userId,
    action: 'account.2fa.setup_started',
    resourceType: 'user',
    resourceId: auth.userId,
    // The secret has no business here. We only trace the fact and the method.
    after: { method: 'totp', backupCodeCount: backupCodes.length },
    ip: auth.ip,
  });

  return withAuthCookies({ totpURI, backupCodes }, response);
});
