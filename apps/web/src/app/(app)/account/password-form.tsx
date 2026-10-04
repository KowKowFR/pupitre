'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n/client';
import { account as messages } from '@/i18n/messages/account';
import { PASSWORD_MIN_LENGTH } from '@/lib/password-policy';
import { toast } from '@/lib/toast';
import { readApiError } from './api-error';

export function PasswordForm() {
  const t = useT(messages);
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // The length check reads under the field, while typing: a banner afterwards
  // would draw the eye far from what needs fixing.
  const tooShort = newPassword.length > 0 && newPassword.length < PASSWORD_MIN_LENGTH;
  const mismatch = confirmation.length > 0 && confirmation !== newPassword;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (newPassword.length < PASSWORD_MIN_LENGTH) {
      setError(t('password.tooShort', { count: PASSWORD_MIN_LENGTH }));
      return;
    }
    if (newPassword !== confirmation) {
      setError(t('password.mismatch'));
      return;
    }

    setPending(true);
    const response = await fetch('/api/account/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword }),
    });

    if (!response.ok) {
      setError(await readApiError(response, t('error.http', { status: response.status })));
      setPending(false);
      return;
    }

    setCurrentPassword('');
    setNewPassword('');
    setConfirmation('');
    toast({ title: t('password.changed') });
    setPending(false);
    router.refresh();
  }

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle>{t('password.title')}</CardTitle>
        <CardDescription>{t('password.description')}</CardDescription>
      </CardHeader>
      <form onSubmit={submit} className="contents">
        <CardContent className="flex flex-1 flex-col gap-4">
          {error ? <Alert variant="destructive">{error}</Alert> : null}

          <Field label={t('password.field.current')}>
            <Input
              type="password"
              autoComplete="current-password"
              required
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
          </Field>

          <Field
            label={t('password.field.new')}
            help={tooShort ? undefined : t('password.min', { count: PASSWORD_MIN_LENGTH })}
            error={
              tooShort
                ? t('password.tooShortTyped', {
                    count: PASSWORD_MIN_LENGTH,
                    typed: newPassword.length,
                  })
                : undefined
            }
          >
            <Input
              type="password"
              autoComplete="new-password"
              required
              minLength={PASSWORD_MIN_LENGTH}
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </Field>

          <Field
            label={t('password.field.confirmation')}
            error={mismatch ? t('password.mismatch') : undefined}
          >
            <Input
              type="password"
              autoComplete="new-password"
              required
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </Field>
        </CardContent>
        <CardFooter>
          <Button type="submit" loading={pending}>
            {pending ? t('password.pending') : t('password.submit')}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
