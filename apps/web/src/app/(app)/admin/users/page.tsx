import type { RoleKey } from '@pupitre/core';
import {
  asc,
  getAppSettingsValue,
  getDb,
  getTwoFactorStates,
  getUserGrants,
  listRoles,
  users,
} from '@pupitre/db';
import { accountStateOf, accountStates } from '@/lib/account-state';
import { mailChannelName } from '@/lib/account-mail';
import { formatSettingsOf } from '@/lib/format';
import { requirePagePermission } from '@/lib/page-auth';
import { UsersView, type AdminUserRow } from './users-view';
import { PASSWORD_MIN_LENGTH } from '@/lib/password-policy';

export const dynamic = 'force-dynamic';

export default async function UsersPage() {
  const auth = await requirePagePermission('/admin/users', 'user:manage');

  const db = getDb();
  // Les rôles proposés viennent de la base : un rôle créé depuis /admin/roles
  // doit être attribuable ici sans recompilation.
  const roleRows = await listRoles(db);
  const rows = await db.select().from(users).orderBy(asc(users.createdAt));
  const grants = await Promise.all(rows.map((row) => getUserGrants(row.id, db)));
  const twoFactor = await getTwoFactorStates(db);
  const settings = await getAppSettingsValue(db);
  const states = await accountStates(db);

  // Le nom du canal, pas seulement « oui / non » : l'écran peut alors dire *par
  // quoi* l'invitation partira, ce qui vaut mieux qu'un « c'est configuré ».
  const channel = await mailChannelName();

  const items: AdminUserRow[] = rows.map((row, index) => {
    const state = states.get(row.id);
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      banned: row.banned,
      banReason: row.banReason,
      roles: grants[index]?.roles ?? [],
      twoFactor: twoFactor.get(row.id) ?? 'none',
      state: accountStateOf(state),
      invitationExpiresAt: state?.invitationExpiresAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  });

  return (
    <UsersView
      items={items}
      currentUserId={auth.userId}
      currentUserName={rows.find((row) => row.id === auth.userId)?.name ?? ''}
      instanceName={settings.instanceName}
      roles={roleRows.map((role) => ({
        key: role.key as RoleKey,
        label: role.label,
        description: role.description,
      }))}
      channel={channel}
      passwordMinLength={PASSWORD_MIN_LENGTH}
      canResetTwoFactor={auth.can('user:reset-2fa')}
      format={formatSettingsOf(settings)}
    />
  );
}
