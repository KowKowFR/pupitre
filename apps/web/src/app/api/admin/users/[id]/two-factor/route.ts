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
 * Réinitialisation du second facteur d'un autre utilisateur — la porte de
 * sortie de quelqu'un qui a perdu son téléphone ET ses codes de secours.
 *
 * `user:reset-2fa`, et pas `user:manage` : le geste lève une protection sur un
 * compte, il ne se donne pas en même temps que le droit de changer un rôle.
 *
 * Sur les sessions, la règle est celle du changement de mot de passe
 * (`revokeOtherSessions`) : toutes celles de la cible tombent. La demande
 * arrive quand un appareil a été perdu ou volé ; laisser vivre la session
 * ouverte sur cet appareil viderait l'opération de son sens. Seule exception,
 * la session de l'appelant lorsqu'il se réinitialise lui-même : la fermer le
 * renverrait à l'écran de connexion sans rien protéger de plus.
 */
export const DELETE = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'user:reset-2fa');
  const { id } = paramsSchema.parse(await context.params);

  const db = getDb();
  const [target] = await db.select().from(users).where(eq(users.id, id));
  if (!target) throw new NotFoundError(msg(admin, 'error.user.notFound', { id }));

  // Se réinitialiser soi-même est permis : un administrateur qui a perdu son
  // téléphone mais tient encore une session est exactement celui qu'on ne veut
  // pas obliger à ouvrir un client SQL. Il ne gagne aucun accès qu'il n'ait
  // déjà, et l'audit garde la trace que l'acteur et la cible ne font qu'un.
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

  // Rien de secret ici : ni l'ancien secret TOTP, ni les codes de secours, qui
  // n'ont de toute façon jamais quitté la base autrement que chiffrés. On trace
  // qui a agi, sur qui, depuis quelle IP, et ce que l'opération a emporté.
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
