'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useT } from '@/i18n/client';
import { account as messages } from '@/i18n/messages/account';
import { PASSWORD_MIN_LENGTH } from '@/lib/password-policy';
import { readApiError } from './api-error';

export function PasswordForm() {
  const t = useT(messages);
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);

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
    setNotice(t('password.changed'));
    setPending(false);
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('password.title')}</CardTitle>
        <CardDescription>{t('password.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          {error ? <Alert variant="destructive">{error}</Alert> : null}
          {notice ? <Alert variant="success">{notice}</Alert> : null}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="current-password">{t('password.field.current')}</Label>
            <Input
              id="current-password"
              type="password"
              autoComplete="current-password"
              required
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-password">{t('password.field.new')}</Label>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              required
              minLength={PASSWORD_MIN_LENGTH}
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
            <p className="text-xs text-text-3">
              {t('password.min', { count: PASSWORD_MIN_LENGTH })}
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="confirm-password">{t('password.field.confirmation')}</Label>
            <Input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              required
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </div>

          <Button type="submit" disabled={pending} className="mt-1 self-start">
            {pending ? t('password.pending') : t('password.submit')}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
