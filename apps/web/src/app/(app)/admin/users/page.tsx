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
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getT } from '@/i18n/server';
import { admin } from '@/i18n/messages/admin';
import { accountStateOf, accountStates } from '@/lib/account-state';
import { mailChannelName } from '@/lib/account-mail';
import { formatSettingsOf } from '@/lib/format';
import { requirePagePermission } from '@/lib/page-auth';
import { CreateUserForm } from './create-user-form';
import { UsersTable, type AdminUserRow } from './users-table';
import { PageHeader } from '@/components/page-header';
import { PASSWORD_MIN_LENGTH } from '@/lib/password-policy';

export const dynamic = 'force-dynamic';

export default async function UsersPage() {
  const auth = await requirePagePermission('/admin/users', 'user:manage');
  const t = await getT(admin);

  const db = getDb();
  // Les rôles proposés viennent de la base : un rôle créé depuis /admin/roles
  // doit être attribuable ici sans recompilation.
  const availableRoles = (await listRoles(db)).map((role) => role.key);
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
    <div className="space-y-6">
      <PageHeader
        title={t('users.title')}
        description={t('users.description')}
      />

      <Card>
        <CardHeader>
          <CardTitle>{channel ? t('users.invite.title') : t('users.create.title')}</CardTitle>
          <CardDescription>
            {channel
              ? t('users.invite.help', { channel, roles: availableRoles.join(', ') })
              : t('users.create.help', {
                  roles: availableRoles.join(', '),
                  min: PASSWORD_MIN_LENGTH,
                })}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {channel ? null : (
            <Alert variant="info">
              {t('users.noMail.before')}{' '}
              <span className="font-medium">{t('users.noMail.settings')}</span>{' '}
              {t('users.noMail.after')}
            </Alert>
          )}
          <CreateUserForm
            roles={availableRoles as readonly RoleKey[]}
            canInvite={channel !== null}
          />
        </CardContent>
      </Card>

      <UsersTable
        items={items}
        currentUserId={auth.userId}
        roles={availableRoles as readonly RoleKey[]}
        canResetTwoFactor={auth.can('user:reset-2fa')}
        format={formatSettingsOf(settings)}
      />
    </div>
  );
}
