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
    /** Requires a second factor when the instance wants it for sensitive rights. */
    sensitive: boolean;
  }>;
};

/**
 * The roles, side by side: one column per role, one row per permission family.
 * Two roles compare at a glance, without unfolding anything. A click on a role
 * opens its drawer — that is where it is read in detail and changed. The drawer
 * follows the URL (`?role=operator`): J/K move from one role to the next, and
 * the link can be shared.
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
  /** The locked role's key, named in the screen's description. */
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
