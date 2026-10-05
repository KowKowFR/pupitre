import {
  PERMISSIONS,
  permissionDescriptions,
  permissionsByResource,
  translator,
} from '@pupitre/core';
import { createRole, createRoleSchema, getRoleByKey, listRolesWithPermissions, logAudit } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { admin } from '@/i18n/messages/admin';
import { currentLanguage } from '@/i18n/server';
import { ConflictError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The roles come from the database, not from a code constant: a role created
 * from the administration screen must appear here without recompiling.
 */
export const GET = apiRoute(async (request) => {
  await requirePermission(request, 'role:read');
  const items = await listRolesWithPermissions();

  // The keys are the contract; the descriptions are only labels, and therefore go
  // out in the instance's language.
  const describe = translator(permissionDescriptions, await currentLanguage());

  return NextResponse.json({
    items,
    total: items.length,
    // The complete vocabulary, so that the editing screen knows what to offer.
    vocabulary: {
      permissions: PERMISSIONS.map((key) => ({
        key,
        description: describe(key),
      })),
      byResource: permissionsByResource(describe),
    },
  });
});

export const POST = apiRoute(async (request) => {
  const auth = await requirePermission(request, 'role:manage');
  const input = await readJsonBody(request, createRoleSchema);

  if (await getRoleByKey(input.key)) {
    throw new ConflictError(msg(admin, 'error.role.exists', { key: input.key }));
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
