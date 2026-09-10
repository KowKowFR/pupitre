import { eq, getDb, getTwoFactorStates, getUserGrants, logAudit, users } from '@tp/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ConflictError, NotFoundError } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { countActiveAdmins } from '../route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().min(1).max(200) });

type Context = { params: Promise<{ id: string }> };

export const GET = apiRoute<Context>(async (request, context) => {
  await requirePermission(request, 'user:read');
  const { id } = paramsSchema.parse(await context.params);

  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, id));
  if (!user) throw new NotFoundError(`Utilisateur « ${id} » introuvable`);

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
    throw new ConflictError('Impossible de supprimer son propre compte');
  }

  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, id));
  if (!user) throw new NotFoundError(`Utilisateur « ${id} » introuvable`);

  const grants = await getUserGrants(id, db);
  if (grants.roles.includes('admin') && (await countActiveAdmins(id)) === 0) {
    throw new ConflictError(
      'Impossible de supprimer le dernier administrateur actif de la plateforme',
    );
  }

  // `audit_logs.actor_id` est en ON DELETE SET NULL : les traces survivent.
  await db.delete(users).where(eq(users.id, id));

  await logAudit({
    actorId: auth.userId,
    action: 'user.deleted',
    resourceType: 'user',
    resourceId: id,
    before: { email: user.email, name: user.name, roles: grants.roles },
    ip: auth.ip,
  });

  return NextResponse.json({ id, deleted: true });
});
