import {
  LOCKED_ROLE,
  permissionDescriptions,
  permissionsByResource,
  resourceLabelOf,
  translator,
} from '@pupitre/core';
import { listRolesWithPermissions } from '@pupitre/db';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { admin } from '@/i18n/messages/admin';
import { currentLanguage, getT } from '@/i18n/server';
import { requirePagePermission } from '@/lib/page-auth';
import { CreateRoleForm } from './create-role-form';
import { RolesEditor, type RoleRow } from './roles-editor';
import { PageHeader } from '@/components/page-header';

export const dynamic = 'force-dynamic';

export default async function RolesPage() {
  const auth = await requirePagePermission('/admin/roles', 'role:read');
  const t = await getT(admin);
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

  const canManage = auth.can('role:manage');

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={t('eyebrow')}
        title={t('roles.title')}
        description={
          <>
            {t('roles.description.before')}{' '}
            <code className="font-mono text-xs">{LOCKED_ROLE}</code>{' '}
            {t('roles.description.after')}
          </>
        }
      />

      {canManage ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('roles.new.title')}</CardTitle>
            <CardDescription>{t('roles.new.help')}</CardDescription>
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
