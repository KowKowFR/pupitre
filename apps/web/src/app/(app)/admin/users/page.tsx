import type { RoleKey } from '@tp/core';
import { asc, getDb, getTwoFactorStates, getUserGrants, listRoles, users } from '@tp/db';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requirePagePermission } from '@/lib/page-auth';
import { CreateUserForm } from './create-user-form';
import { UsersTable, type AdminUserRow } from './users-table';

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

  const items: AdminUserRow[] = rows.map((row, index) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    banned: row.banned,
    banReason: row.banReason,
    roles: grants[index]?.roles ?? [],
    twoFactor: twoFactor.get(row.id) ?? 'none',
    createdAt: row.createdAt.toISOString(),
  }));

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Utilisateurs</h1>
        <p className="text-muted-foreground text-sm">
          Un utilisateur porte un rôle ; le rôle porte les permissions.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Créer un utilisateur</CardTitle>
          <CardDescription>
            Rôles disponibles : {availableRoles.join(', ')}. Mot de passe de 12 caractères minimum.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CreateUserForm roles={availableRoles as readonly RoleKey[]} />
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
