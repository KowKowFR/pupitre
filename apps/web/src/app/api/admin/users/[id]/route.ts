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
   * The current invitation and reset links die **before** the account.
   *
   * `verifications` carries no foreign key to `users` — Better Auth stores a user
   * identifier in a text column there —, so nothing would carry them off in a
   * cascade. They would survive until their expiry, up to three days, pointing at
   * an account that no longer exists. It is not exploitable (the targeted account
   * is gone), but a link lingering in a mailbox after the account's deletion is
   * exactly what we try not to leave behind.
   */
  const revokedLinks = await revokeResetTokens(id);

  // `audit_logs.actor_id` is ON DELETE SET NULL: the traces survive.
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
