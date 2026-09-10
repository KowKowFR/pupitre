'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { RoleKey } from '@tp/core';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

/** Miroir de `TwoFactorState` (`@tp/db`) — le client ne dépend pas de la base. */
export type TwoFactorState = 'none' | 'pending' | 'active';

export type AdminUserRow = {
  id: string;
  name: string;
  email: string;
  banned: boolean;
  banReason: string | null;
  roles: RoleKey[];
  twoFactor: TwoFactorState;
  createdAt: string;
};

type ApiErrorBody = { error?: { message?: string } };

export function UsersTable({
  items,
  currentUserId,
  roles,
  canResetTwoFactor,
}: {
  items: AdminUserRow[];
  currentUserId: string;
  roles: readonly RoleKey[];
  canResetTwoFactor: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [resetting, setResetting] = useState(false);
  /** Utilisateur dont la réinitialisation est en cours de confirmation. */
  const [confirmTarget, setConfirmTarget] = useState<AdminUserRow | null>(null);

  async function call(url: string, init: RequestInit) {
    setError(null);
    setNotice(null);
    const response = await fetch(url, {
      headers: { 'content-type': 'application/json' },
      ...init,
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiErrorBody;
      setError(body.error?.message ?? `Échec (HTTP ${response.status})`);
      return;
    }
    startTransition(() => router.refresh());
  }

  async function resetTwoFactor(user: AdminUserRow) {
    setError(null);
    setNotice(null);
    setResetting(true);
    try {
      const response = await fetch(`/api/admin/users/${user.id}/two-factor`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as ApiErrorBody;
        setError(body.error?.message ?? `Échec (HTTP ${response.status})`);
        return;
      }
      const body = (await response.json()) as { revokedSessions?: number };
      const revoked = body.revokedSessions ?? 0;
      setNotice(
        `Second facteur de ${user.email} réinitialisé. ` +
          (revoked > 0
            ? `${revoked} session${revoked > 1 ? 's' : ''} fermée${revoked > 1 ? 's' : ''}. `
            : 'Aucune session ouverte à fermer. ') +
          'Il se reconnecte avec son seul mot de passe.',
      );
      setConfirmTarget(null);
      startTransition(() => router.refresh());
    } finally {
      setResetting(false);
    }
  }

  return (
    <Card>
      <CardContent className="space-y-4">
        {error ? <Alert variant="destructive">{error}</Alert> : null}
        {notice ? <Alert variant="info">{notice}</Alert> : null}

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Utilisateur</TableHead>
              <TableHead>Rôle</TableHead>
              <TableHead>État</TableHead>
              <TableHead>Second facteur</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((user) => {
              const isSelf = user.id === currentUserId;
              return (
                <TableRow key={user.id}>
                  <TableCell>
                    <div className="text-sm font-medium">
                      {user.name}
                      {isSelf ? (
                        <span className="text-muted-foreground font-normal"> (vous)</span>
                      ) : null}
                    </div>
                    <div className="text-muted-foreground text-xs">{user.email}</div>
                  </TableCell>
                  <TableCell>
                    <Select
                      className="h-8 w-36"
                      value={user.roles[0] ?? 'viewer'}
                      disabled={pending}
                      onChange={(event) =>
                        void call(`/api/admin/users/${user.id}/role`, {
                          method: 'PATCH',
                          body: JSON.stringify({ role: event.target.value }),
                        })
                      }
                    >
                      {roles.map((role) => (
                        <option key={role} value={role}>
                          {role}
                        </option>
                      ))}
                    </Select>
                  </TableCell>
                  <TableCell>
                    {user.banned ? (
                      <Badge variant="destructive" title={user.banReason ?? undefined}>
                        désactivé
                      </Badge>
                    ) : (
                      <Badge variant="secondary">actif</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <TwoFactorBadge state={user.twoFactor} />
                  </TableCell>
                  <TableCell className="space-x-2 text-right">
                    {canResetTwoFactor && user.twoFactor !== 'none' ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending || resetting}
                        onClick={() => setConfirmTarget(user)}
                      >
                        Réinitialiser le 2FA
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant={user.banned ? 'secondary' : 'outline'}
                      disabled={pending || isSelf}
                      onClick={() =>
                        void call(`/api/admin/users/${user.id}/status`, {
                          method: 'PATCH',
                          body: JSON.stringify({ banned: !user.banned }),
                        })
                      }
                    >
                      {user.banned ? 'Réactiver' : 'Désactiver'}
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>

      <ResetTwoFactorDialog
        target={confirmTarget}
        isSelf={confirmTarget?.id === currentUserId}
        pending={resetting}
        onCancel={() => setConfirmTarget(null)}
        onConfirm={(user) => void resetTwoFactor(user)}
      />
    </Card>
  );
}

function TwoFactorBadge({ state }: { state: TwoFactorState }) {
  if (state === 'active') return <Badge variant="ok">actif</Badge>;
  if (state === 'pending') {
    return (
      <Badge variant="warn" title="Secret généré, jamais confirmé par un code">
        configuration en cours
      </Badge>
    );
  }
  return <span className="text-muted-foreground text-xs">aucun</span>;
}

/**
 * La modale nomme l'utilisateur et énumère ce que la réinitialisation emporte.
 * Un « êtes-vous sûr ? » ne dit rien de ce qu'on s'apprête à défaire.
 */
function ResetTwoFactorDialog({
  target,
  isSelf,
  pending,
  onCancel,
  onConfirm,
}: {
  target: AdminUserRow | null;
  isSelf: boolean;
  pending: boolean;
  onCancel: () => void;
  onConfirm: (user: AdminUserRow) => void;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => (open ? undefined : onCancel())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Réinitialiser le second facteur</DialogTitle>
          <DialogDescription>
            {target
              ? `${target.name} — ${target.email}`
              : 'Aucun utilisateur sélectionné.'}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-3 text-[0.8125rem]">
          <p>Après validation, pour ce compte :</p>
          <ul className="text-ink-muted list-disc space-y-1 pl-5">
            <li>le secret TOTP est supprimé — l’application d’authentification ne sert plus ;</li>
            <li>les codes de secours déjà émis cessent immédiatement de fonctionner ;</li>
            <li>
              {isSelf
                ? 'vos autres sessions sont fermées ; celle-ci reste ouverte.'
                : 'toutes ses sessions en cours sont fermées, y compris sur un appareil perdu.'}
            </li>
            <li>
              la connexion se fait ensuite avec le mot de passe seul, jusqu’à ce que la personne
              reconfigure un second facteur depuis <code>/account</code>.
            </li>
          </ul>
          <Alert variant="warn">
            Vérifiez l’identité du demandeur avant de continuer : ce geste retire une protection,
            et rien ne le défait à distance.
          </Alert>
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onCancel}>
            Annuler
          </Button>
          <Button
            variant="destructive"
            disabled={pending || target === null}
            onClick={() => (target ? onConfirm(target) : undefined)}
          >
            {pending ? 'Réinitialisation…' : `Réinitialiser le 2FA de ${target?.name ?? ''}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
