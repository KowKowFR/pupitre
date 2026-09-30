'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { RoleKey } from '@pupitre/core';
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
import {
  Table,
  TableActions,
  TableActionsHead,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useT } from '@/i18n/client';
import { admin } from '@/i18n/messages/admin';
import { common } from '@/i18n/messages/common';
import { formatDateTimeWith, type FormatSettings } from '@/lib/format';
import type { Translate } from '@pupitre/core';

/** Miroir de `TwoFactorState` (`@pupitre/db`) — le client ne dépend pas de la base. */
export type TwoFactorState = 'none' | 'pending' | 'active';

/** Miroir d'`AccountState` (route `/api/admin/users`). */
export type AccountState = 'invited' | 'expired' | 'active';

export type AdminUserRow = {
  id: string;
  name: string;
  email: string;
  banned: boolean;
  banReason: string | null;
  roles: RoleKey[];
  twoFactor: TwoFactorState;
  /** Invité (lien vivant), invitation périmée, ou compte actif. */
  state: AccountState;
  invitationExpiresAt: string | null;
  createdAt: string;
};

type ApiErrorBody = { error?: { message?: string } };

type T = Translate<typeof admin.fr>;

export function UsersTable({
  items,
  currentUserId,
  roles,
  canResetTwoFactor,
  format,
}: {
  items: AdminUserRow[];
  currentUserId: string;
  roles: readonly RoleKey[];
  canResetTwoFactor: boolean;
  /** Locale et fuseau de l'instance. Par props : cette table est rendue sur le
   *  serveur avant de l'être ici, et les deux doivent écrire la même date. */
  format: FormatSettings;
}) {
  const router = useRouter();
  const t = useT(admin);
  const c = useT(common);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [resetting, setResetting] = useState(false);
  /** Identifiant de l'utilisateur dont l'invitation est en cours de traitement. */
  const [inviting, setInviting] = useState<string | null>(null);
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
      setError(body.error?.message ?? c('http.failure', { status: response.status }));
      return;
    }
    startTransition(() => router.refresh());
  }

  /**
   * Relancer ou annuler une invitation.
   *
   * Les deux passent par la même route (`POST` / `DELETE`) et rendent le nombre
   * de liens tués : c'est ce qui permet de dire « l'ancien lien ne fonctionne
   * plus » plutôt que de laisser croire qu'on en a juste ajouté un.
   */
  async function invitation(user: AdminUserRow, method: 'POST' | 'DELETE') {
    setError(null);
    setNotice(null);
    setInviting(user.id);
    try {
      const response = await fetch(`/api/admin/users/${user.id}/invitation`, {
        method,
        headers: { 'content-type': 'application/json' },
      });
      const body = (await response.json().catch(() => ({}))) as ApiErrorBody & {
        revokedLinks?: number;
        invitation?: { sent?: boolean; channel?: string | null; error?: string | null };
      };
      if (!response.ok) {
        setError(body.error?.message ?? c('http.failure', { status: response.status }));
        return;
      }
      if (method === 'DELETE') {
        setNotice(
          t('users.invitation.revoked', { email: user.email, count: body.revokedLinks ?? 0 }),
        );
      } else if (body.invitation?.sent) {
        setNotice(
          t('users.invitation.resent', {
            email: user.email,
            channel: body.invitation.channel ?? 'SMTP',
          }),
        );
      } else {
        setError(
          t('users.invitation.failed', {
            email: user.email,
            reason: body.invitation?.error ?? t('users.reason.unknown'),
          }),
        );
      }
      startTransition(() => router.refresh());
    } finally {
      setInviting(null);
    }
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
        setError(body.error?.message ?? c('http.failure', { status: response.status }));
        return;
      }
      const body = (await response.json()) as { revokedSessions?: number };
      const revoked = body.revokedSessions ?? 0;
      setNotice(
        [
          t('users.2fa.notice.head', { email: user.email }),
          revoked > 0
            ? t('users.2fa.notice.closed', { count: revoked })
            : t('users.2fa.notice.none'),
          t('users.2fa.notice.tail'),
        ].join(' '),
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
              <TableHead>{t('users.column.user')}</TableHead>
              <TableHead>{t('users.column.role')}</TableHead>
              <TableHead>{c('column.state')}</TableHead>
              <TableHead>{t('users.column.twoFactor')}</TableHead>
              <TableActionsHead>{c('column.actions')}</TableActionsHead>
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
                        <span className="text-muted-foreground font-normal">
                          {' '}
                          {t('users.self')}
                        </span>
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
                    <AccountStateBadge user={user} t={t} format={format} />
                  </TableCell>
                  <TableCell>
                    <TwoFactorBadge state={user.twoFactor} t={t} />
                  </TableCell>
                  <TableActions className="space-x-2 whitespace-nowrap">
                    {user.state !== 'active' && !user.banned ? (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={pending || inviting === user.id}
                          onClick={() => void invitation(user, 'POST')}
                        >
                          {user.state === 'expired'
                            ? t('users.action.inviteAgain')
                            : t('users.action.resend')}
                        </Button>
                        {user.state === 'invited' ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={pending || inviting === user.id}
                            onClick={() => void invitation(user, 'DELETE')}
                          >
                            {t('users.action.cancelLink')}
                          </Button>
                        ) : null}
                      </>
                    ) : null}
                    {canResetTwoFactor && user.twoFactor !== 'none' ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending || resetting}
                        onClick={() => setConfirmTarget(user)}
                      >
                        {t('users.action.reset2fa')}
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
                      {user.banned ? t('users.action.reactivate') : c('disable')}
                    </Button>
                  </TableActions>
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

/**
 * L'état du compte, en un badge.
 *
 * « Désactivé » l'emporte sur tout le reste : c'est le fait qui compte, et un
 * compte désactivé n'a pas d'invitation en cours qui vaille la peine d'être
 * lue. Les deux états d'invitation, eux, sont distincts parce qu'ils appellent
 * deux gestes différents — relancer, ou attendre.
 */
function AccountStateBadge({
  user,
  t,
  format,
}: {
  user: AdminUserRow;
  t: T;
  format: FormatSettings;
}) {
  if (user.banned) {
    return (
      <Badge variant="destructive" title={user.banReason ?? undefined}>
        {t('users.state.disabled')}
      </Badge>
    );
  }
  if (user.state === 'invited') {
    return (
      <Badge
        variant="warn"
        title={
          user.invitationExpiresAt
            ? t('users.invitation.validUntil', {
                // `settings.locale` tel quel : la langue à deux lettres
                // rendait « 2:32 PM » sur une instance réglée sur `en-GB`.
                date: formatDateTimeWith(user.invitationExpiresAt, format, {
                  dateStyle: 'short',
                  timeStyle: 'medium',
                }),
              })
            : undefined
        }
      >
        {t('users.state.invited')}
      </Badge>
    );
  }
  if (user.state === 'expired') {
    return (
      <Badge variant="destructive" title={t('users.state.expired.title')}>
        {t('users.state.expired')}
      </Badge>
    );
  }
  return <Badge variant="secondary">{t('users.state.active')}</Badge>;
}

function TwoFactorBadge({ state, t }: { state: TwoFactorState; t: T }) {
  if (state === 'active') return <Badge variant="ok">{t('users.2fa.active')}</Badge>;
  if (state === 'pending') {
    return (
      <Badge variant="warn" title={t('users.2fa.pending.title')}>
        {t('users.2fa.pending')}
      </Badge>
    );
  }
  return <span className="text-muted-foreground text-xs">{t('users.2fa.none')}</span>;
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
  const t = useT(admin);
  const c = useT(common);

  return (
    <Dialog open={target !== null} onOpenChange={(open) => (open ? undefined : onCancel())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('users.2fa.dialog.title')}</DialogTitle>
          <DialogDescription>
            {target ? `${target.name} — ${target.email}` : t('users.2fa.dialog.noTarget')}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-3 text-[0.8125rem]">
          <p>{t('users.2fa.dialog.intro')}</p>
          <ul className="text-text-2 list-disc space-y-1 pl-5">
            <li>{t('users.2fa.dialog.totp')}</li>
            <li>{t('users.2fa.dialog.backup')}</li>
            <li>
              {isSelf ? t('users.2fa.dialog.sessionsSelf') : t('users.2fa.dialog.sessionsOther')}
            </li>
            <li>
              {t('users.2fa.dialog.after')} <code>/account</code>.
            </li>
          </ul>
          <Alert variant="warn">{t('users.2fa.dialog.warn')}</Alert>
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onCancel}>
            {c('cancel')}
          </Button>
          <Button
            variant="destructive"
            disabled={pending || target === null}
            onClick={() => (target ? onConfirm(target) : undefined)}
          >
            {pending
              ? t('users.2fa.dialog.pending')
              : t('users.2fa.dialog.confirm', { name: target?.name ?? '' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
