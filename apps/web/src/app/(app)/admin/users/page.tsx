import type { RoleKey } from '@pupitre/core';
import { asc, getDb, getTwoFactorStates, getUserGrants, listRoles, users } from '@pupitre/db';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { accountStateOf, accountStates } from '@/lib/account-state';
import { mailChannelName } from '@/lib/account-mail';
import { requirePagePermission } from '@/lib/page-auth';
import { CreateUserForm } from './create-user-form';
import { UsersTable, type AdminUserRow } from './users-table';
import { PageHeader } from '@/components/page-header';
import { PASSWORD_MIN_LENGTH } from '@/lib/password-policy';

export const dynamic = 'force-dynamic';

export default async function UsersPage() {
  const auth = await requirePagePermission('/admin/users', 'user:manage');

  const db = getDb();
  // Les rôles proposés viennent de la base : un rôle créé depuis /admin/roles
  // doit être attribuable ici sans recompilation.
  const availableRoles = (await listRoles(db)).map((role) => role.key);
  const rows = await db.select().from(users).orderBy(asc(users.createdAt));
  const grants = await Promise.all(rows.map((row) => getUserGrants(row.id, db)));
  const twoFactor = await getTwoFactorStates(db);
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
        eyebrow="Administration"
        title="Utilisateurs"
        description="Un utilisateur porte un rôle ; le rôle porte les permissions. Désactiver un compte coupe ses sessions en cours — il n'est pas supprimé, et son passage reste dans les logs."
      />

      <Card>
        <CardHeader>
          <CardTitle>{channel ? 'Inviter un utilisateur' : 'Créer un utilisateur'}</CardTitle>
          <CardDescription>
            {channel ? (
              <>
                La personne reçoit un lien par e-mail (canal «&nbsp;{channel}&nbsp;») et choisit
                elle-même son mot de passe&nbsp;: personne d&apos;autre ne le connaîtra. Le lien
                vaut 72&nbsp;heures et ne fonctionne qu&apos;une fois. Rôles disponibles&nbsp;:{' '}
                {availableRoles.join(', ')}.
              </>
            ) : (
              <>
                Rôles disponibles&nbsp;: {availableRoles.join(', ')}. Mot de passe de{' '}
                {PASSWORD_MIN_LENGTH} caractères minimum.
              </>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {channel ? null : (
            <Alert variant="info">
              Aucun canal e-mail (SMTP) actif&nbsp;: le mot de passe doit être saisi ici, puis
              transmis hors bande — et vous le connaîtrez. Configurez un serveur SMTP dans{' '}
              <span className="font-medium">Paramètres → Notifications</span> pour inviter par lien
              à la place, et pour que «&nbsp;mot de passe oublié&nbsp;» fonctionne sur l&apos;écran
              de connexion.
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
      />
    </div>
  );
}
