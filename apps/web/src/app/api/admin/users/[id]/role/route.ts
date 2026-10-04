import { LOCKED_ROLE } from '@pupitre/core';
import { eq, getDb, getRoleByKey, getUserGrants, logAudit, roleKeySchema, setUserRoles, users } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { admin } from '@/i18n/messages/admin';
import { ConflictError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { countActiveAdmins } from '@/lib/admins';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().min(1).max(200) });
// The roles are data: the valid list is read in the database, not in a frozen
// union that would require recompiling the panel to create one.
const bodySchema = z.object({ role: roleKeySchema });

type Context = { params: Promise<{ id: string }> };

export const PATCH = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'user:manage');
  const { id } = paramsSchema.parse(await context.params);
  const { role } = await readJsonBody(request, bodySchema);

  const db = getDb();
  const [target] = await db.select().from(users).where(eq(users.id, id));
  if (!target) throw new NotFoundError(msg(admin, 'error.user.notFound', { id }));

  if (!(await getRoleByKey(role, db))) {
    throw new NotFoundError(msg(admin, 'error.role.notFound', { key: role }));
  }

  const before = await getUserGrants(id, db);

  // Removing the platform's last active administrator is forbidden.
  if (before.roles.includes(LOCKED_ROLE) && role !== LOCKED_ROLE) {
    if ((await countActiveAdmins(id)) === 0) {
      throw new ConflictError(msg(admin, 'error.user.lastAdmin.role'));
    }
  }

  await setUserRoles(id, [role], db);

  await logAudit({
    actorId: auth.userId,
    action: 'user.role.changed',
    resourceType: 'user',
    resourceId: id,
    before: { roles: before.roles },
    after: { roles: [role], email: target.email },
    ip: auth.ip,
  });

  return NextResponse.json({ id, roles: [role] });
});
