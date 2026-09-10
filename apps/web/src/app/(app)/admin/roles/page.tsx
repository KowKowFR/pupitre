import { LOCKED_ROLE, RESOURCE_LABELS, permissionsByResource } from '@tp/core';
import { listRolesWithPermissions } from '@tp/db';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requirePagePermission } from '@/lib/page-auth';
import { CreateRoleForm } from './create-role-form';
import { RolesEditor, type RoleRow } from './roles-editor';

export const dynamic = 'force-dynamic';

export default async function RolesPage() {
  const auth = await requirePagePermission('/admin/roles', 'role:read');

  const roles = await listRolesWithPermissions();

  const items: RoleRow[] = roles.map((role) => ({
    key: role.key,
    label: role.label,
    description: role.description,
    locked: role.locked,
    permissions: role.permissions,
    userCount: role.userCount,
  }));

  const groups = permissionsByResource().map((group) => ({
    resource: group.resource,
    label: RESOURCE_LABELS[group.resource] ?? group.resource,
    permissions: group.permissions,
  }));

  const canManage = auth.can('role:manage');

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Rôles</h1>
        <p className="text-muted-foreground text-sm">
          Un utilisateur porte un rôle ; le rôle porte les permissions. Le rôle{' '}
          <code className="font-mono text-xs">{LOCKED_ROLE}</code> est verrouillé : il détient
          toujours l&apos;intégralité des permissions, pour qu&apos;on ne puisse pas se retirer les
          droits nécessaires à se les rendre.
        </p>
      </div>

      {canManage ? (
        <Card>
          <CardHeader>
            <CardTitle>Nouveau rôle</CardTitle>
            <CardDescription>
              La clé sert d&apos;identifiant et ne change plus ensuite. Les permissions se règlent
              juste après la création.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CreateRoleForm existingKeys={items.map((item) => item.key)} />
          </CardContent>
        </Card>
      ) : null}

      <RolesEditor roles={items} groups={groups} canManage={canManage} />
    </div>
  );
}
