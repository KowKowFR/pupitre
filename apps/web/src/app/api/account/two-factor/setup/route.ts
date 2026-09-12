import { logAudit } from '@pupitre/db';
import { z } from 'zod';
import { getAuth } from '@/lib/auth';
import { HttpError } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requireSession } from '@/lib/rbac';
import { assertBetterAuthOk, withAuthCookies } from '../../better-auth-call';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({ password: z.string().min(1) });

/**
 * Première moitié de l'activation : Better Auth génère un secret et des codes
 * de secours, mais laisse la ligne `two_factors` en `verified = false`. Le
 * second facteur n'est pas encore armé — il le sera à `/activate`, une fois un
 * code valide fourni.
 *
 * C'est la SEULE réponse du panel qui porte le secret TOTP et les codes de
 * secours. Ils ne repassent ni par le journal d'audit, ni par les logs.
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
    await assertBetterAuthOk(response, "La configuration du second facteur a été refusée.");
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
    throw new HttpError(502, 'totp_uri_missing', "Better Auth n'a pas renvoyé d'URI TOTP.");
  }

  await logAudit({
    actorId: auth.userId,
    action: 'account.2fa.setup_started',
    resourceType: 'user',
    resourceId: auth.userId,
    // Le secret n'a rien à faire ici. On ne trace que le fait et la méthode.
    after: { method: 'totp', backupCodeCount: backupCodes.length },
    ip: auth.ip,
  });

  return withAuthCookies({ totpURI, backupCodes }, response);
});
