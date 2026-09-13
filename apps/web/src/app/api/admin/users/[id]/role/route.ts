import { LOCKED_ROLE } from '@pupitre/core';
import { eq, getDb, getRoleByKey, getUserGrants, logAudit, roleKeySchema, setUserRoles, users } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { admin } from '@/i18n/messages/admin';
import { ConflictError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { countActiveAdmins } from '../../route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().min(1).max(200) });
// Les rôles sont des données : la liste valide se lit en base, pas dans une
// union figée qui obligerait à recompiler le panel pour en créer un.
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

  // Interdit de retirer le dernier administrateur actif de la plateforme.
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
