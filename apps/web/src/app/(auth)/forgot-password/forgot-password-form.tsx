'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useT } from '@/i18n/client';
import { auth as messages } from '@/i18n/messages/auth';
import { requestPasswordReset } from '@/lib/auth-client';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { AuthCard } from '../auth-card';

/**
 * Asking for a reset link.
 *
 * ## The rule that governs this screen: it never says who has an account
 *
 * "This address does not exist" would tell a stranger who works here. The screen
 * therefore shows **the same message in both cases**, and it is not politeness:
 * it is the only answer it knows. Better Auth also returns an identical `200` — it
 * goes as far as simulating a token's generation on the "unknown" path so that
 * both take the same time.
 *
 * An assumed consequence: someone who gets the address wrong will wait for an
 * email that will not come. The message says so — "if an account exists" — rather
 * than suggest an outage.
 *
 * The success screen replaces the form instead of leaving it beside: starting it
 * ten times would only hit the rate limit (three requests per minute), and a
 * button one can hammer invites hammering.
 */
export function ForgotPasswordForm() {
  const t = useT(messages);
  const [sent, setSent] = useState(false);
  const [throttled, setThrottled] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);

    const form = new FormData(event.currentTarget);
    const result = await requestPasswordReset({
      email: String(form.get('email') ?? ''),
      // Serves as the link's fallback destination. The email's text, for its part,
      // does not depend on this parameter: it is decided on the server side, from the
      // account's state. See `sendResetPassword` in `lib/auth.ts`.
      redirectTo: '/reset-password',
    });

    // The only failure we tell apart is the rate limit — because it teaches nothing
    // about the account's existence, and because staying silent would suggest the
    // message went out.
    setThrottled(result.error?.status === 429);
    setSent(true);
    setPending(false);
  }

  if (sent) {
    return (
      <AuthCard title={t('forgot.sent.title')} description={t('forgot.sent.description')}>
        {throttled ? (
          <Alert variant="destructive">{t('forgot.throttled')}</Alert>
        ) : (
          <Alert variant="info">{t('forgot.sent.notice')}</Alert>
        )}
        <Button asChild variant="secondary" className="btn-block">
          <Link href="/login">{t('link.backToLogin')}</Link>
        </Button>
      </AuthCard>
    );
  }

  return (
    <AuthCard title={t('forgot.title')} description={t('forgot.description')}>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field label={t('field.email')}>
          <Input name="email" type="email" autoComplete="email" required autoFocus />
        </Field>
        <Button type="submit" className="btn-block" loading={pending}>
          {pending ? t('forgot.pending') : t('forgot.submit')}
        </Button>
        <p className="t-cap text-center">
          <Link href="/login" className="link">
            {t('link.backToLogin')}
          </Link>
        </p>
      </form>
    </AuthCard>
  );
}
