import {
  LockedRoleError,
  RoleInUseError,
  deleteRole,
  getRoleByKey,
  logAudit,
  roleKeySchema,
  updateRole,
  updateRoleSchema,
} from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { admin } from '@/i18n/messages/admin';
import { ConflictError, HttpError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ key: roleKeySchema });
type Context = { params: Promise<{ key: string }> };

/** A locked role is read, but not changed: 409, not 403. */
function translate(error: unknown): never {
  if (error instanceof LockedRoleError) {
    throw new HttpError(409, 'role_locked', msg(admin, 'roles.error.locked', { key: error.key }), {
      key: error.key,
    });
  }
  if (error instanceof RoleInUseError) {
    throw new HttpError(
      409,
      'role_in_use',
      msg(admin, 'roles.error.inUse', { key: error.key, count: error.userCount }),
      { key: error.key, userCount: error.userCount },
    );
  }
  throw error;
}

export const GET = apiRoute<Context>(async (request, context) => {
  await requirePermission(request, 'role:read');
  const { key } = paramsSchema.parse(await context.params);

  const role = await getRoleByKey(key);
  if (!role) throw new NotFoundError(msg(admin, 'error.role.notFound', { key }));

  return NextResponse.json(role);
});

export const PATCH = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'role:manage');
  const { key } = paramsSchema.parse(await context.params);
  const patch = await readJsonBody(request, updateRoleSchema);

  const before = await getRoleByKey(key);
  if (!before) throw new NotFoundError(msg(admin, 'error.role.notFound', { key }));

  const after = await updateRole(key, patch).catch(translate);
  if (!after) throw new NotFoundError(msg(admin, 'error.role.notFound', { key }));

  await logAudit({
    actorId: auth.userId,
    action: 'role.updated',
    resourceType: 'role',
    resourceId: key,
    before: { label: before.label, permissions: before.permissions },
    after: { label: after.label, permissions: after.permissions },
    ip: auth.ip,
  });

  return NextResponse.json(after);
});

export const DELETE = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'role:manage');
  const { key } = paramsSchema.parse(await context.params);

  const role = await getRoleByKey(key);
  if (!role) throw new NotFoundError(msg(admin, 'error.role.notFound', { key }));

  const removed = await deleteRole(key).catch(translate);
  if (!removed) throw new ConflictError(msg(admin, 'error.role.deleteFailed', { key }));

  await logAudit({
    actorId: auth.userId,
    action: 'role.deleted',
    resourceType: 'role',
    resourceId: key,
    before: { label: role.label, permissions: role.permissions },
    ip: auth.ip,
  });

  return NextResponse.json({ key, deleted: true });
});
