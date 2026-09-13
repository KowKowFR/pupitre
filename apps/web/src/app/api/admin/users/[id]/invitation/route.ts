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
 * Relancer une invitation.
 *
 * Le cas courant : le lien a expiré, ou le message s'est perdu. Sans ce bouton,
 * la seule issue serait de supprimer le compte et de le recréer — en lui
 * faisant perdre son rôle et sa place dans le journal.
 *
 * **Les liens précédents meurent d'abord.** C'est la partie non négociable :
 * deux liens vivants pour un même compte, c'est un lien qu'on croit avoir
 * annulé et qui ouvre encore la porte. Better Auth n'invalide pas les jetons
 * antérieurs quand il en crée un nouveau — c'est à nous de le faire.
 */
export const POST = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'user:manage');
  const { id } = paramsSchema.parse(await context.params);

  const db = getDb();
  const [target] = await db.select().from(users).where(eq(users.id, id));
  if (!target) throw new NotFoundError(msg(admin, 'error.user.notFound', { id }));

  if (await hasPassword(id)) {
    // Le compte est actif : la personne a déjà choisi son mot de passe. Lui
    // renvoyer une « invitation » serait une réinitialisation déguisée, décidée
    // par quelqu'un d'autre qu'elle. Si elle est bloquée, c'est à elle de
    // demander une réinitialisation depuis l'écran de connexion.
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
 * Annuler une invitation : les liens en cours meurent, le compte reste.
 *
 * Deux gestes distincts, comme « détruire » et « purger » le sont pour un
 * déploiement. Celui-ci referme la porte sans effacer la personne — utile quand
 * l'adresse était fausse, ou quand l'arrivée est reportée. Pour effacer le
 * compte, c'est `DELETE /api/admin/users/{id}`.
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
