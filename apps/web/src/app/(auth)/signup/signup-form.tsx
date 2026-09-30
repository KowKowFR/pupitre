'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useT } from '@/i18n/client';
import { auth as messages } from '@/i18n/messages/auth';
import { common } from '@/i18n/messages/common';
import { signUp } from '@/lib/auth-client';
import { PASSWORD_MIN_LENGTH } from '@/lib/password-policy';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { AuthCard } from '../auth-card';

export function SignupForm() {
  const t = useT(messages);
  const tc = useT(common);
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const form = new FormData(event.currentTarget);
    const password = String(form.get('password') ?? '');

    if (password.length < PASSWORD_MIN_LENGTH) {
      setError(t('password.tooShort', { count: PASSWORD_MIN_LENGTH }));
      setPending(false);
      return;
    }

    const result = await signUp.email({
      name: String(form.get('name') ?? ''),
      email: String(form.get('email') ?? ''),
      password,
    });

    if (result.error) {
      setError(result.error.message ?? t('signup.failed'));
      setPending(false);
      return;
    }

    router.push('/');
    router.refresh();
  }

  return (
    <AuthCard title={t('signup.title')} description={t('signup.description')}>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        {error ? <Alert variant="destructive">{error}</Alert> : null}
        <Field label={t('field.name')}>
          <Input name="name" autoComplete="name" required autoFocus />
        </Field>
        <Field label={t('field.email')}>
          <Input name="email" type="email" autoComplete="email" required />
        </Field>
        <Field label={t('field.password')} help={t('password.min', { count: PASSWORD_MIN_LENGTH })}>
          <Input
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={PASSWORD_MIN_LENGTH}
            required
          />
        </Field>
        <Button type="submit" className="btn-block" loading={pending}>
          {pending ? tc('creating') : t('signup.submit')}
        </Button>
        <p className="t-cap text-center text-text-3">
          {t('signup.haveAccount')}{' '}
          <Link href="/login" className="link">
            {t('login.submit')}
          </Link>
        </p>
      </form>
    </AuthCard>
  );
}
