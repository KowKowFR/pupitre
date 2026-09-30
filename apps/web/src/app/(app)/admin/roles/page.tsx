import {
  LOCKED_ROLE,
  permissionDescriptions,
  permissionsByResource,
  resourceLabelOf,
  translator,
} from '@pupitre/core';
import { listRolesWithPermissions } from '@pupitre/db';
import { currentLanguage } from '@/i18n/server';
import { requirePagePermission } from '@/lib/page-auth';
import { RolesEditor, type RoleRow } from './roles-editor';

export const dynamic = 'force-dynamic';

export default async function RolesPage() {
  const auth = await requirePagePermission('/admin/roles', 'role:read');
  const language = await currentLanguage();

  const roles = await listRolesWithPermissions();

  const items: RoleRow[] = roles.map((role) => ({
    key: role.key,
    label: role.label,
    description: role.description,
    locked: role.locked,
    permissions: role.permissions,
    userCount: role.userCount,
  }));

  // Les libellés de permission sont rendus ici, au serveur : l'éditeur reçoit
  // des phrases, pas des clés à traduire une deuxième fois côté client.
  const groups = permissionsByResource(translator(permissionDescriptions, language)).map(
    (group) => ({
      resource: group.resource,
      label: resourceLabelOf(group.resource, language),
      permissions: group.permissions,
    }),
  );

  return (
    <RolesEditor
      roles={items}
      groups={groups}
      canManage={auth.can('role:manage')}
      lockedRole={LOCKED_ROLE}
    />
  );
}
