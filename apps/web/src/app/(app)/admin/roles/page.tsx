import {
  LOCKED_ROLE,
  isSensitivePermission,
  permissionDescriptions,
  permissionsByResource,
  resourceLabelOf,
  translator,
} from '@pupitre/core';
import { getAppSettingsValue, listRolesWithPermissions } from '@pupitre/db';
import { currentLanguage } from '@/i18n/server';
import { requirePagePermission } from '@/lib/page-auth';
import { RolesEditor, type RoleRow } from './roles-editor';

export const dynamic = 'force-dynamic';

export default async function RolesPage() {
  const auth = await requirePagePermission('/admin/roles', 'role:read');
  const language = await currentLanguage();

  const [roles, settings] = await Promise.all([listRolesWithPermissions(), getAppSettingsValue()]);

  const items: RoleRow[] = roles.map((role) => ({
    key: role.key,
    label: role.label,
    description: role.description,
    locked: role.locked,
    permissions: role.permissions,
    userCount: role.userCount,
  }));

  // The permission labels are rendered here, on the server: the editor receives
  // sentences, not keys to translate a second time on the client side.
  const groups = permissionsByResource(translator(permissionDescriptions, language)).map(
    (group) => ({
      resource: group.resource,
      label: resourceLabelOf(group.resource, language),
      permissions: group.permissions.map((permission) => ({
        ...permission,
        sensitive: isSensitivePermission(permission.key),
      })),
    }),
  );

  return (
    <RolesEditor
      roles={items}
      groups={groups}
      canManage={auth.can('role:manage')}
      lockedRole={LOCKED_ROLE}
      twoFactorPolicy={settings.accounts.twoFactorPolicy}
    />
  );
}
