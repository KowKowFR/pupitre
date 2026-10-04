'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { RoleKey } from '@pupitre/core';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useT } from '@/i18n/client';
import { admin } from '@/i18n/messages/admin';
import { common } from '@/i18n/messages/common';
import { PASSWORD_MIN_LENGTH } from '@/lib/password-policy';

type ApiErrorBody = { error?: { message?: string } };

export type CreatedUser = {
  id: string;
  email: string;
  name: string;
  roles: RoleKey[];
  /** The sending's verdict, `null` when the account was created with a password. */
  invitation: { sent: boolean; channel: string | null; error: string | null } | null;
};

/**
 * A single form, two regimes — and **never both at once**.
 *
 * `canInvite` is not a display preference: it is the instance's capability. When
 * an active SMTP channel exists, the "password" field purely and simply
 * disappears, and the administrator can no longer make up a password they would
 * then have to pass on through some channel. When there is none — the state of
 * a new instance —, it is the only possible path, and the screen says so instead
 * of offering an invitation that would not go out.
 *
 * It is the answer to "keeping the form next to the invitation leaves two ways
 * of doing the same thing": there are never two in front of an operator.
 *
 * `onCreated` is the onboarding assistant's extension point: same route, same
 * audit. Absent, the form behaves as on `/admin/users`.
 */
export function CreateUserForm({
  roles,
  canInvite,
  onCreated,
}: {
  roles: readonly RoleKey[];
  /** Can the instance send an email? Decides the form's regime. */
  canInvite: boolean;
  onCreated?: (user: CreatedUser) => void;
}) {
  const router = useRouter();
  const t = useT(admin);
  const c = useT(common);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setNotice(null);

    const formElement = event.currentTarget;
    const form = new FormData(formElement);

    const email = String(form.get('email') ?? '');

    const response = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: String(form.get('name') ?? ''),
        email,
        // Field omitted in the invitation regime: its absence is what tells the route
        // "invite instead of creating". Sending an empty string would fail the
        // validation instead of switching regime.
        ...(canInvite ? {} : { password: String(form.get('password') ?? '') }),
        role: String(form.get('role') ?? 'viewer'),
      }),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiErrorBody;
      setError(body.error?.message ?? c('http.failure', { status: response.status }));
      setPending(false);
      return;
    }

    const created = (await response.json().catch(() => null)) as CreatedUser | null;

    formElement.reset();
    setPending(false);

    // The account exists in every case; the email, on the other hand, may not have
    // gone out. Saying "invitation sent" without knowing would be exactly the
    // silence this journey must avoid.
    if (!canInvite) {
      setNotice(t('users.created.notice'));
    } else if (created?.invitation?.sent) {
      setNotice(t('users.invited.notice', { email }));
    } else {
      setError(
        t('users.invited.failed', {
          email,
          reason: created?.invitation?.error ?? t('users.reason.unknown'),
        }),
      );
    }

    if (created) onCreated?.(created);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      {error ? <Alert variant="destructive">{error}</Alert> : null}
      {notice ? <Alert variant="success">{notice}</Alert> : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={t('users.form.name')}>
          <Input name="name" required />
        </Field>
        <Field label={t('users.form.email')}>
          <Input name="email" type="email" required />
        </Field>
        {canInvite ? null : (
          <Field label={t('users.form.password')}>
            <Input
              name="password"
              type="password"
              minLength={PASSWORD_MIN_LENGTH}
              autoComplete="new-password"
              required
            />
          </Field>
        )}
        <Field label={t('users.form.role')}>
          <Select name="role" defaultValue="viewer">
            {roles.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="flex justify-end">
        <Button type="submit" loading={pending}>
          {pending
            ? canInvite
              ? t('users.form.sending')
              : c('creating')
            : canInvite
              ? t('users.form.invite')
              : t('users.form.create')}
        </Button>
      </div>
    </form>
  );
}
