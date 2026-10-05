'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useT } from '@/i18n/client';
import { auth as messages } from '@/i18n/messages/auth';
import { common } from '@/i18n/messages/common';
import { resetPassword } from '@/lib/auth-client';
import { PASSWORD_MIN_LENGTH } from '@/lib/password-policy';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { AuthCard } from './auth-card';

/**
 * Choosing a password from a link.
 *
 * **A single component for two screens** — accepting an invitation and resetting
 * one's password. The mechanism is strictly the same: a single-use token made and
 * consumed by Better Auth, a `POST /api/auth/reset-password`. What changes is the
 * person's situation, hence the words; making two forms of it would make two
 * places where to fix the same bug.
 *
 * Nothing is reimplemented here: neither the token's validation, nor its expiry,
 * nor its single use, nor the closing of sessions. This screen takes a password
 * and reads an answer.
 */

export type ChoosePasswordCopy = {
  title: string;
  description: string;
  submit: string;
  /** What is shown when everything went well. */
  doneTitle: string;
  doneBody: string;
  /** What is shown when the link is dead. */
  deadTitle: string;
  deadBody: string;
};

export function ChoosePasswordForm({
  token,
  linkError,
  copy,
}: {
  /** The token extracted from the URL. `null` if the link did not carry one. */
  token: string | null;
  /** The error code set by Better Auth on the link (`INVALID_TOKEN`…). */
  linkError: string | null;
  copy: ChoosePasswordCopy;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);
  /**
   * The token was refused **at submission**. Told apart from a link dead on arrival:
   * here the person typed a password for nothing, and showing them the form again
   * would invite them to start over endlessly.
   */
  const [consumed, setConsumed] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const form = new FormData(event.currentTarget);
    const password = String(form.get('password') ?? '');
    const confirmation = String(form.get('confirmation') ?? '');

    if (password.length < PASSWORD_MIN_LENGTH) {
      setError(t('password.tooShort', { count: PASSWORD_MIN_LENGTH }));
      return;
    }
    // Checked here and not on the server side: it is a guard against typos, not a
    // security rule. The server has no reason to receive the same string twice.
    if (password !== confirmation) {
      setError(t('choose.mismatch'));
      return;
    }
    if (!token) {
      setError(t('choose.noToken'));
      return;
    }

    setPending(true);
    const result = await resetPassword({ newPassword: password, token });
    setPending(false);

    if (result.error) {
      // A refused token is not retried: it expired, or it was already used.
      if (result.error.status === 400) {
        setConsumed(true);
        return;
      }
      setError(result.error.status === 429 ? t('choose.throttled') : t('choose.rejected'));
      return;
    }

    setDone(true);
  }

  if (done) {
    return (
      <AuthCard title={copy.doneTitle} description={copy.doneBody}>
        <Button
          className="btn-block"
          onClick={() => {
            router.push('/login');
            router.refresh();
          }}
        >
          {t('login.submit')}
        </Button>
      </AuthCard>
    );
  }

  // Dead link — either refused on arrival by Better Auth's check, or refused at
  // submission because it had just been used.
  if (consumed || linkError || !token) {
    return (
      <AuthCard title={copy.deadTitle} description={copy.deadBody}>
        <p className="t-sm text-text-2">{t('choose.dead.notice')}</p>
        <Button asChild className="btn-block">
          <Link href="/forgot-password">{t('choose.newLink')}</Link>
        </Button>
        <p className="t-cap text-center">
          <Link href="/login" className="link">
            {t('link.backToLogin')}
          </Link>
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard title={copy.title} description={copy.description}>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        {error ? <Alert variant="destructive">{error}</Alert> : null}
        <Field label={t('field.password')} help={t('password.min', { count: PASSWORD_MIN_LENGTH })}>
          <Input
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={PASSWORD_MIN_LENGTH}
            required
            autoFocus
          />
        </Field>
        <Field label={t('field.confirmation')}>
          <Input
            name="confirmation"
            type="password"
            autoComplete="new-password"
            minLength={PASSWORD_MIN_LENGTH}
            required
          />
        </Field>
        <Button type="submit" className="btn-block" loading={pending}>
          {pending ? tc('saving') : copy.submit}
        </Button>
      </form>
    </AuthCard>
  );
}
