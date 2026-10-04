'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  Ellipsis,
  ImageOff,
  Link2Off,
  Power,
  Send,
  ShieldAlert,
  ShieldCheck,
  UserPlus,
} from 'lucide-react';
import type { RoleKey, Translate } from '@pupitre/core';
import { PageHeader } from '@/components/page-header';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Avatar } from '@/components/ui/data';
import { Drawer, DrawerBody, DrawerFooter, DrawerHeader } from '@/components/ui/drawer';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
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
import { IconButton } from '@/components/ui/tooltip';
import { useT } from '@/i18n/client';
import { admin } from '@/i18n/messages/admin';
import { common } from '@/i18n/messages/common';
import { formatDateTimeWith, type FormatSettings } from '@/lib/format';
import { toast } from '@/lib/toast';

/** Mirror of `TwoFactorState` (`@pupitre/db`) — the client does not depend on the database. */
export type TwoFactorState = 'none' | 'pending' | 'active';

/** Miroir d'`AccountState` (route `/api/admin/users`). */
export type AccountState = 'invited' | 'expired' | 'active';

export type AdminUserRow = {
  id: string;
  name: string;
  email: string;
  /** The versioned URL of their profile picture, or `null`. */
  image: string | null;
  banned: boolean;
  banReason: string | null;
  roles: RoleKey[];
  twoFactor: TwoFactorState;
  /** The instance's policy requires it from this account ("Accounts and sessions"). */
  twoFactorRequired: boolean;
  /** Invited (live link), expired invitation, or active account. */
  state: AccountState;
  invitationExpiresAt: string | null;
  createdAt: string;
};

export type RoleOption = { key: RoleKey; label: string; description: string | null };

type ApiErrorBody = { error?: { message?: string } };

type CreatedUser = {
  id: string;
  email: string;
  name: string;
  roles: RoleKey[];
  /** The sending's verdict, `null` when the account was created with a password. */
  invitation: { sent: boolean; channel: string | null; error: string | null } | null;
};

type T = Translate<typeof admin.fr>;

export function UsersView({
  items,
  currentUserId,
  currentUserName,
  instanceName,
  roles,
  channel,
  passwordMinLength,
  canResetTwoFactor,
  format,
}: {
  items: AdminUserRow[];
  currentUserId: string;
  currentUserName: string;
  instanceName: string;
  roles: readonly RoleOption[];
  /** The active email channel, or `null`: decides the form's regime. */
  channel: string | null;
  passwordMinLength: number;
  canResetTwoFactor: boolean;
  /** The instance's locale and time zone. Through props: this table is rendered on
   *  the server before being rendered here, and both must write the same date. */
  format: FormatSettings;
}) {
  const router = useRouter();
  const t = useT(admin);
  const c = useT(common);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  /** The identifier of the user whose invitation is being processed. */
  const [inviting, setInviting] = useState<string | null>(null);
  /** The user whose reset is being confirmed. */
  const [confirmTarget, setConfirmTarget] = useState<AdminUserRow | null>(null);
  /** The invitation drawer's opening key: a fresh form each time. */
  const [creating, setCreating] = useState<number | null>(null);

  async function call(url: string, init: RequestInit, done?: string) {
    setError(null);
    const response = await fetch(url, {
      headers: { 'content-type': 'application/json' },
      ...init,
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiErrorBody;
      setError(body.error?.message ?? c('http.failure', { status: response.status }));
      return;
    }
    if (done) toast({ title: done });
    startTransition(() => router.refresh());
  }

  /**
   * Resending or cancelling an invitation.
   *
   * Both go through the same route (`POST` / `DELETE`) and return the number of
   * links killed: that is what allows saying "the old link no longer works"
   * rather than letting one believe that a new one was merely added.
   */
  async function invitation(user: AdminUserRow, method: 'POST' | 'DELETE') {
    setError(null);
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
        toast({
          title: t('users.invitation.revoked', {
            email: user.email,
            count: body.revokedLinks ?? 0,
          }),
        });
      } else if (body.invitation?.sent) {
        toast({
          title: t('users.invitation.resent', {
            email: user.email,
            channel: body.invitation.channel ?? 'SMTP',
          }),
        });
      } else {
        toast({
          title: t('users.invitation.failed', {
            email: user.email,
            reason: body.invitation?.error ?? t('users.reason.unknown'),
          }),
          tone: 'danger',
        });
      }
      startTransition(() => router.refresh());
    } finally {
      setInviting(null);
    }
  }

  async function resetTwoFactor(user: AdminUserRow) {
    setResetError(null);
    setResetting(true);
    try {
      const response = await fetch(`/api/admin/users/${user.id}/two-factor`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as ApiErrorBody;
        setResetError(body.error?.message ?? c('http.failure', { status: response.status }));
        return;
      }
      const body = (await response.json()) as { revokedSessions?: number };
      const revoked = body.revokedSessions ?? 0;
      toast({
        title: t('users.2fa.notice.head', { email: user.email }),
        description: [
          revoked > 0
            ? t('users.2fa.notice.closed', { count: revoked })
            : t('users.2fa.notice.none'),
          t('users.2fa.notice.tail'),
        ].join(' '),
      });
      setConfirmTarget(null);
      startTransition(() => router.refresh());
    } finally {
      setResetting(false);
    }
  }

  const isSelfTarget = confirmTarget?.id === currentUserId;

  return (
    <>
      <PageHeader
        title={t('users.title')}
        description={t('users.description')}
        actions={
          <Button onClick={() => setCreating((key) => (key ?? 0) + 1)}>
            <UserPlus aria-hidden />
            {channel ? t('users.invite.title') : t('users.create.title')}
          </Button>
        }
      />

      {error ? <Alert variant="destructive">{error}</Alert> : null}

      <section className="card overflow-hidden">
        <Table label={t('users.title')}>
          <TableHeader>
            <TableRow>
              <TableHead>{t('users.column.user')}</TableHead>
              <TableHead>{t('users.column.role')}</TableHead>
              <TableHead>{c('column.state')}</TableHead>
              <TableHead>{t('users.column.twoFactor')}</TableHead>
              <TableActionsHead>
                <span className="sr-only">{c('column.actions')}</span>
              </TableActionsHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((user) => {
              const isSelf = user.id === currentUserId;
              return (
                <TableRow key={user.id}>
                  <TableCell>
                    <span className="flex items-center gap-2.5">
                      <Avatar name={user.name || user.email} src={user.image} />
                      <span className="flex min-w-0 flex-col">
                        <span className="cellname truncate">
                          {user.name}
                          {isSelf ? (
                            <span className="t-cap font-normal text-text-3">
                              {' '}
                              {t('users.self')}
                            </span>
                          ) : null}
                        </span>
                        <span className="t-cap truncate text-text-3">{user.email}</span>
                      </span>
                    </span>
                  </TableCell>
                  <TableCell>
                    <Select
                      className="input-sm w-[150px]"
                      aria-label={t('users.role.aria', { name: user.name })}
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
                        <option key={role.key} value={role.key}>
                          {role.label}
                        </option>
                      ))}
                    </Select>
                  </TableCell>
                  <TableCell>
                    <AccountState user={user} t={t} format={format} />
                  </TableCell>
                  <TableCell>
                    <TwoFactorBadge
                      state={user.twoFactor}
                      required={user.twoFactorRequired}
                      t={t}
                    />
                  </TableCell>
                  <TableActions>
                    <span className="inline-flex items-center gap-1.5">
                      {canResetTwoFactor && user.twoFactor !== 'none' ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={pending || resetting}
                          onClick={() => {
                            setResetError(null);
                            setConfirmTarget(user);
                          }}
                        >
                          {t('users.action.reset2fa')}
                        </Button>
                      ) : null}
                      {user.state !== 'active' && !user.banned ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={inviting === user.id}
                          disabled={pending}
                          onClick={() => void invitation(user, 'POST')}
                        >
                          {user.state === 'expired'
                            ? t('users.action.inviteAgain')
                            : t('users.action.resend')}
                        </Button>
                      ) : null}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <IconButton label={t('users.more')} size="icon-sm">
                            <Ellipsis />
                          </IconButton>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-64">
                          {user.state === 'invited' && !user.banned ? (
                            <DropdownMenuItem
                              disabled={inviting === user.id}
                              onSelect={() => void invitation(user, 'DELETE')}
                            >
                              <Link2Off aria-hidden />
                              {t('users.action.cancelLink')}
                            </DropdownMenuItem>
                          ) : null}
                          {user.image ? (
                            // Moderating an inappropriate picture: it goes, the account stays.
                            <DropdownMenuItem
                              onSelect={() =>
                                void call(
                                  `/api/admin/users/${user.id}/avatar`,
                                  { method: 'DELETE' },
                                  `${t('users.action.removeAvatar')} · ${user.email}`,
                                )
                              }
                            >
                              <ImageOff aria-hidden />
                              {t('users.action.removeAvatar')}
                            </DropdownMenuItem>
                          ) : null}
                          {isSelf ? (
                            // A refused gesture is spelled out, in its place.
                            <DropdownMenuLabel className="t-cap font-normal text-text-3">
                              {t('error.user.disableSelf')}
                            </DropdownMenuLabel>
                          ) : (
                            <DropdownMenuItem
                              destructive={!user.banned}
                              onSelect={() =>
                                void call(
                                  `/api/admin/users/${user.id}/status`,
                                  {
                                    method: 'PATCH',
                                    body: JSON.stringify({ banned: !user.banned }),
                                  },
                                  user.banned
                                    ? `${t('users.action.reactivate')} · ${user.email}`
                                    : `${c('disable')} · ${user.email}`,
                                )
                              }
                            >
                              <Power aria-hidden />
                              {user.banned ? t('users.action.reactivate') : c('disable')}
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </span>
                  </TableActions>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        <div className="pager">{t('users.footnote')}</div>
      </section>

      <Drawer
        open={creating !== null}
        onOpenChange={(open) => (open ? undefined : setCreating(null))}
        label={channel ? t('users.invite.title') : t('users.create.title')}
      >
        {creating !== null ? (
          <CreateUser
            key={creating}
            roles={roles}
            channel={channel}
            inviterName={currentUserName}
            instanceName={instanceName}
            passwordMinLength={passwordMinLength}
            onDone={() => {
              setCreating(null);
              startTransition(() => router.refresh());
            }}
            onCancel={() => setCreating(null)}
          />
        ) : null}
      </Drawer>

      <ConfirmDialog
        open={confirmTarget !== null}
        onOpenChange={(open) => (open ? undefined : setConfirmTarget(null))}
        level="trace"
        icon={<ShieldAlert />}
        title={confirmTarget ? t('users.2fa.dialog.titleFor', { name: confirmTarget.name }) : ''}
        description={t('users.2fa.dialog.intro')}
        consequences={[
          t('users.2fa.dialog.totp'),
          t('users.2fa.dialog.backup'),
          isSelfTarget ? t('users.2fa.dialog.sessionsSelf') : t('users.2fa.dialog.sessionsOther'),
          <>
            {t('users.2fa.dialog.after')} <code className="mono">/account</code>.
          </>,
        ]}
        confirmLabel={t('users.2fa.dialog.confirm', {
          name: confirmTarget?.name.split(' ')[0] ?? '',
        })}
        pendingLabel={t('users.2fa.dialog.pending')}
        pending={resetting}
        error={resetError}
        onConfirm={() => (confirmTarget ? resetTwoFactor(confirmTarget) : undefined)}
      >
        <Alert variant="warn">{t('users.2fa.dialog.warn')}</Alert>
      </ConfirmDialog>
    </>
  );
}

/**
 * The invitation — or the creation, without an email channel — in a drawer. The
 * form shows what the person will receive: a subject, a link, and the promise
 * that nobody else will know their password.
 */
function CreateUser({
  roles,
  channel,
  inviterName,
  instanceName,
  passwordMinLength,
  onDone,
  onCancel,
}: {
  roles: readonly RoleOption[];
  channel: string | null;
  inviterName: string;
  instanceName: string;
  passwordMinLength: number;
  onDone: () => void;
  onCancel: () => void;
}) {
  const t = useT(admin);
  const c = useT(common);
  const canInvite = channel !== null;
  const [name, setName] = useState('');
  const [role, setRole] = useState<string>(
    roles.find((entry) => entry.key === 'viewer')?.key ?? roles[0]?.key ?? 'viewer',
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const description = roles.find((entry) => entry.key === role)?.description ?? undefined;

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') ?? '');

    const response = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        email,
        // Field omitted in the invitation regime: its absence is what tells the route
        // "invite instead of creating". Sending an empty string would fail the
        // validation instead of switching regime.
        ...(canInvite ? {} : { password: String(form.get('password') ?? '') }),
        role,
      }),
    });

    setPending(false);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiErrorBody;
      setError(body.error?.message ?? c('http.failure', { status: response.status }));
      return;
    }

    const created = (await response.json().catch(() => null)) as CreatedUser | null;

    // The account exists in every case; the email, on the other hand, may not have
    // gone out. Saying "invitation sent" without knowing would be exactly the
    // silence this journey must avoid.
    if (!canInvite) {
      toast({ title: t('users.created.notice') });
    } else if (created?.invitation?.sent) {
      toast({ title: t('users.invited.notice', { email }) });
    } else {
      toast({
        title: t('users.invited.failed', {
          email,
          reason: created?.invitation?.error ?? t('users.reason.unknown'),
        }),
        tone: 'danger',
      });
    }
    onDone();
  }

  const firstName = name.trim().split(/\s+/)[0] ?? '';

  return (
    <form className="contents" onSubmit={(event) => void onSubmit(event)}>
      <DrawerHeader
        icon={<UserPlus />}
        kind={t('users.title')}
        title={canInvite ? t('users.invite.title') : t('users.create.title')}
        state={
          <span className="text-text-2">
            {canInvite ? t('users.drawer.invite') : t('users.drawer.create')}
          </span>
        }
      />
      <DrawerBody>
        {error ? <Alert variant="destructive">{error}</Alert> : null}
        <Field label={t('users.form.name')}>
          <Input
            name="name"
            required
            autoComplete="off"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label={t('users.form.email')}>
          <Input name="email" type="email" required autoComplete="off" />
        </Field>
        {canInvite ? null : (
          <Field label={t('users.form.password')}>
            <Input
              name="password"
              type="password"
              minLength={passwordMinLength}
              required
              autoComplete="new-password"
            />
          </Field>
        )}
        <Field label={t('users.form.role')} help={description}>
          <Select value={role} onChange={(event) => setRole(event.target.value)}>
            {roles.map((entry) => (
              <option key={entry.key} value={entry.key}>
                {entry.label}
              </option>
            ))}
          </Select>
        </Field>

        {canInvite ? (
          <>
            <div className="flex flex-col gap-2">
              <span className="text-[13.5px] font-semibold text-text">
                {t('users.preview.title', { name: firstName || t('users.preview.someone') })}
              </span>
              <div className="well flex flex-col gap-1">
                <span className="t-sm">
                  <strong>{t('users.preview.subject')}</strong>{' '}
                  {t('users.preview.subjectText', { inviter: inviterName, instance: instanceName })}
                </span>
                <span className="t-cap text-text-3">{t('users.preview.body')}</span>
              </div>
            </div>
            <Alert variant="info">{t('users.channel.info', { channel })}</Alert>
          </>
        ) : (
          <Alert variant="info">
            {t('users.noMail.before')} <strong>{t('users.noMail.settings')}</strong>{' '}
            {t('users.noMail.after')}
          </Alert>
        )}
      </DrawerBody>
      <DrawerFooter end={null}>
        <Button type="submit" loading={pending}>
          {pending ? null : canInvite ? <Send aria-hidden /> : <UserPlus aria-hidden />}
          {pending
            ? canInvite
              ? t('users.form.sending')
              : c('creating')
            : canInvite
              ? t('users.form.send')
              : t('users.form.create')}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {c('cancel')}
        </Button>
      </DrawerFooter>
    </form>
  );
}

/**
 * The account's state, as a chip.
 *
 * "Disabled" wins over everything else: it is the fact that counts, and a
 * disabled account has no invitation in progress worth reading. The two
 * invitation states, for their part, are distinct because they call for two
 * different gestures — resend, or wait.
 */
function AccountState({ user, t, format }: { user: AdminUserRow; t: T; format: FormatSettings }) {
  if (user.banned) {
    return (
      <Badge variant="danger" title={user.banReason ?? undefined}>
        {t('users.state.disabled')}
      </Badge>
    );
  }
  if (user.state === 'invited') {
    return (
      <span className="flex flex-col items-start gap-0.5">
        <Badge variant="accent">{t('users.state.invited')}</Badge>
        {user.invitationExpiresAt ? (
          <span className="t-cap text-text-3">
            {t('users.invitation.validUntil', {
              // `settings.locale` as is: the two-letter language rendered "2:32 PM" on an
              // instance set to `en-GB`.
              date: formatDateTimeWith(user.invitationExpiresAt, format, {
                day: '2-digit',
                month: '2-digit',
              }),
            })}
          </span>
        ) : null}
      </span>
    );
  }
  if (user.state === 'expired') {
    return (
      <Badge variant="danger" title={t('users.state.expired.title')}>
        {t('users.state.expired')}
      </Badge>
    );
  }
  return <Badge className="mono">{t('users.state.active')}</Badge>;
}

function TwoFactorBadge({
  state,
  required,
  t,
}: {
  state: TwoFactorState;
  required: boolean;
  t: T;
}) {
  if (state === 'active') {
    return (
      <Badge variant="ok">
        <ShieldCheck aria-hidden className="size-3" />
        {t('users.2fa.active')}
      </Badge>
    );
  }
  if (state === 'pending') {
    return (
      <Badge variant="warn" title={t('users.2fa.pending.title')}>
        {t('users.2fa.pending')}
      </Badge>
    );
  }
  if (required) {
    return (
      <Badge variant="danger" title={t('users.2fa.missing.title')}>
        {t('users.2fa.missing')}
      </Badge>
    );
  }
  return <Badge variant="outline">{t('users.2fa.none')}</Badge>;
}
