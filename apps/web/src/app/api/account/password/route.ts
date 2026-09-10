import { logAudit } from '@tp/db';
import { z } from 'zod';
import { getAuth } from '@/lib/auth';
import { HttpError } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { PASSWORD_MIN_LENGTH } from '@/lib/password-policy';
import { requireSession } from '@/lib/rbac';
import { assertBetterAuthOk, withAuthCookies } from '../better-auth-call';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Changement de mot de passe par son propriétaire.
 *
 * Aucune permission RBAC : agir sur son propre compte n'est pas un privilège.
 * `requireSession()` suffit — et `currentPassword` est obligatoire, sinon un
 * cookie volé suffirait à s'emparer définitivement du compte.
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
      // Toutes les autres sessions tombent. Un mot de passe qu'on change est
      // un mot de passe qu'on suppose compromis : laisser ouvertes les sessions
      // déjà volées viderait la manœuvre de son intérêt. Better Auth réémet un
      // cookie pour l'appelant, relayé plus bas.
      revokeOtherSessions: true,
    },
    headers: request.headers,
    asResponse: true,
  });

  try {
    await assertBetterAuthOk(response, 'Le changement de mot de passe a été refusé.');
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

  // Aucun mot de passe dans le journal — ni l'ancien, ni le nouveau, ni leur
  // longueur : seul le fait que l'opération a eu lieu est traçable.
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
