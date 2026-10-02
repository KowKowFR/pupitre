import { eq, getDb, getTwoFactorStates, getUserGrants, logAudit, users } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { revokeResetTokens } from '@/lib/auth';
import { admin } from '@/i18n/messages/admin';
import { ConflictError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { countActiveAdmins } from '@/lib/admins';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().min(1).max(200) });

type Context = { params: Promise<{ id: string }> };

export const GET = apiRoute<Context>(async (request, context) => {
  await requirePermission(request, 'user:read');
  const { id } = paramsSchema.parse(await context.params);

  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, id));
  if (!user) throw new NotFoundError(msg(admin, 'error.user.notFound', { id }));

  const grants = await getUserGrants(id, db);
  const twoFactor = await getTwoFactorStates(db);
  return NextResponse.json({
    id: user.id,
    name: user.name,
    email: user.email,
    banned: user.banned,
    banReason: user.banReason,
    roles: grants.roles,
    permissions: grants.permissions,
    twoFactor: twoFactor.get(id) ?? 'none',
    createdAt: user.createdAt.toISOString(),
  });
});

export const DELETE = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'user:manage');
  const { id } = paramsSchema.parse(await context.params);

  if (id === auth.userId) {
    throw new ConflictError(msg(admin, 'error.user.deleteSelf'));
  }

  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, id));
  if (!user) throw new NotFoundError(msg(admin, 'error.user.notFound', { id }));

  const grants = await getUserGrants(id, db);
  if (grants.roles.includes('admin') && (await countActiveAdmins(id)) === 0) {
    throw new ConflictError(msg(admin, 'error.user.lastAdmin.delete'));
  }

  /**
   * Les liens d'invitation et de réinitialisation en cours meurent **avant** le
   * compte.
   *
   * `verifications` ne porte aucune clé étrangère vers `users` — Better Auth y
   * range un identifiant d'utilisateur dans une colonne de texte —, donc rien
   * ne les emporterait en cascade. Ils survivraient jusqu'à leur échéance, soit
   * jusqu'à trois jours, en pointant sur un compte qui n'existe plus. Ce n'est
   * pas exploitable (le compte visé a disparu), mais un lien qui traîne dans
   * une boîte mail après la suppression du compte est exactement ce qu'on
   * cherche à ne pas laisser derrière soi.
   */
  const revokedLinks = await revokeResetTokens(id);

  // `audit_logs.actor_id` est en ON DELETE SET NULL : les traces survivent.
  await db.delete(users).where(eq(users.id, id));

  await logAudit({
    actorId: auth.userId,
    action: 'user.deleted',
    resourceType: 'user',
    resourceId: id,
    before: { email: user.email, name: user.name, roles: grants.roles },
    after: { revokedLinks },
    ip: auth.ip,
  });

  return NextResponse.json({ id, deleted: true, revokedLinks });
});
