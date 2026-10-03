'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import type { Permission, TwoFactorPolicy } from '@pupitre/core';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { useDrawerSelection } from '@/components/ui/drawer';
import { useT } from '@/i18n/client';
import { admin } from '@/i18n/messages/admin';
import { toast } from '@/lib/toast';
import { NewRoleDrawer } from './new-role-drawer';
import { RoleDrawer } from './role-drawer';
import { RolesMatrix } from './roles-matrix';

export type RoleRow = {
  key: string;
  label: string;
  description: string | null;
  locked: boolean;
  permissions: Permission[];
  userCount: number;
};

export type PermissionGroup = {
  resource: string;
  label: string;
  permissions: Array<{
    key: Permission;
    action: string;
    description: string;
    /** Exige un second facteur quand l'instance le veut pour les droits sensibles. */
    sensitive: boolean;
  }>;
};

/**
 * Les rôles, côte à côte : une colonne par rôle, une ligne par famille de
 * permissions. On compare deux rôles d'un coup d'œil, sans rien déplier. Un
 * clic sur un rôle ouvre son tiroir — c'est là qu'on le lit en détail et qu'on
 * le modifie. Le tiroir suit l'URL (`?role=operator`) : J/K passent d'un rôle
 * à l'autre, et le lien se partage.
 */
export function RolesEditor({
  roles,
  groups,
  canManage,
  lockedRole,
  twoFactorPolicy,
}: {
  roles: RoleRow[];
  groups: PermissionGroup[];
  canManage: boolean;
  /** La clé du rôle verrouillé, nommée dans la description de l'écran. */
  lockedRole: string;
  twoFactorPolicy: TwoFactorPolicy;
}) {
  const t = useT(admin);
  const [creating, setCreating] = useState(false);
  const drawer = useDrawerSelection(
    'role',
    roles.map((role) => role.key),
  );
  const current = roles.find((role) => role.key === drawer.selected) ?? null;

  return (
    <>
      <PageHeader
        title={t('roles.title')}
        description={
          <>
            {t('roles.description.before')} <code className="mono">{lockedRole}</code>{' '}
            {t('roles.description.after')}
          </>
        }
        actions={
          canManage ? (
            <Button onClick={() => setCreating(true)}>
              <Plus aria-hidden />
              {t('roles.new.action')}
            </Button>
          ) : undefined
        }
      />

      <RolesMatrix
        roles={roles}
        groups={groups}
        canManage={canManage}
        twoFactorPolicy={twoFactorPolicy}
        selected={drawer.selected}
        onOpen={drawer.open}
      />

      <RoleDrawer
        role={current}
        groups={groups}
        canManage={canManage}
        twoFactorPolicy={twoFactorPolicy}
        onClose={drawer.close}
        onPrevious={drawer.onPrevious}
        onNext={drawer.onNext}
      />

      {canManage ? (
        <NewRoleDrawer
          open={creating}
          existingKeys={roles.map((role) => role.key)}
          groups={groups}
          onClose={() => setCreating(false)}
          onCreated={(role) => {
            setCreating(false);
            drawer.open(role.key);
            toast({ title: t('roles.created', { label: role.label }), tone: 'ok' });
          }}
        />
      ) : null}
    </>
  );
}
