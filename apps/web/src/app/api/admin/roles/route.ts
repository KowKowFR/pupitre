import { PERMISSIONS, PERMISSION_DESCRIPTIONS, permissionsByResource } from '@tp/core';
import { createRole, createRoleSchema, getRoleByKey, listRolesWithPermissions, logAudit } from '@tp/db';
import { NextResponse } from 'next/server';
import { ConflictError } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Les rôles viennent de la base, pas d'une constante du code : un rôle créé
 * depuis l'écran d'administration doit apparaître ici sans recompilation.
 */
export const GET = apiRoute(async (request) => {
  await requirePermission(request, 'role:read');
  const items = await listRolesWithPermissions();

  return NextResponse.json({
    items,
    total: items.length,
    // Le vocabulaire complet, pour que l'écran d'édition sache quoi proposer.
    vocabulary: {
      permissions: PERMISSIONS.map((key) => ({
        key,
        description: PERMISSION_DESCRIPTIONS[key],
      })),
      byResource: permissionsByResource(),
    },
  });
});

export const POST = apiRoute(async (request) => {
  const auth = await requirePermission(request, 'role:manage');
  const input = await readJsonBody(request, createRoleSchema);

  if (await getRoleByKey(input.key)) {
    throw new ConflictError(`Un rôle « ${input.key} » existe déjà`);
  }

  const role = await createRole(input);

  await logAudit({
    actorId: auth.userId,
    action: 'role.created',
    resourceType: 'role',
    resourceId: role.key,
    after: { label: role.label, permissions: role.permissions },
    ip: auth.ip,
  });

  return NextResponse.json(role, { status: 201 });
});
