import { logAudit } from '@pupitre/db';
import { z } from 'zod';
import { getAuth } from '@/lib/auth';
import { HttpError } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requireSession } from '@/lib/rbac';
import { assertBetterAuthOk, withAuthCookies } from '../../better-auth-call';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({ code: z.string().regex(/^\d{6}$/) });

/**
 * Seconde moitié de l'activation : un premier code doit être valide avant que
 * le second facteur ne soit réellement armé. Sans cette étape, un utilisateur
 * dont l'application d'authentification est mal réglée se retrouverait enfermé
 * dehors à la prochaine connexion.
 *
 * Better Auth fait tourner le cookie de session en marquant `twoFactorEnabled` :
 * la réponse relaie ses `Set-Cookie`.
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
    await assertBetterAuthOk(response, "Le code n'a pas été accepté.");
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
