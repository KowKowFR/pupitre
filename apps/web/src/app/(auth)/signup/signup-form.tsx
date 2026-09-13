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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

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
    <Card className="shadow-raised">
      <CardHeader>
        <CardTitle className="text-lg">{t('signup.title')}</CardTitle>
        <CardDescription>{t('signup.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          {error ? <Alert variant="destructive">{error}</Alert> : null}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name">{t('field.name')}</Label>
            <Input id="name" name="name" autoComplete="name" required autoFocus />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">{t('field.email')}</Label>
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">{t('field.password')}</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={PASSWORD_MIN_LENGTH}
              required
            />
            <p className="text-xs text-ink-faint">
              {t('password.min', { count: PASSWORD_MIN_LENGTH })}
            </p>
          </div>
          <Button type="submit" className="mt-1 w-full" disabled={pending}>
            {pending ? tc('creating') : t('signup.submit')}
          </Button>
          <p className="text-center text-xs text-ink-muted">
            {t('signup.haveAccount')}{' '}
            <Link
              href="/login"
              className="text-signal underline decoration-signal-edge underline-offset-4 hover:decoration-signal"
            >
              {t('login.submit')}
            </Link>
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
