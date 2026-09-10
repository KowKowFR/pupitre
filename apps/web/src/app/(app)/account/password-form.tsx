'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PASSWORD_MIN_LENGTH } from '@/lib/password-policy';
import { readApiError } from './api-error';

export function PasswordForm() {
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
      setError(`Le mot de passe doit faire au moins ${PASSWORD_MIN_LENGTH} caractères.`);
      return;
    }
    if (newPassword !== confirmation) {
      setError('La confirmation ne correspond pas au nouveau mot de passe.');
      return;
    }

    setPending(true);
    const response = await fetch('/api/account/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword }),
    });

    if (!response.ok) {
      setError(await readApiError(response));
      setPending(false);
      return;
    }

    setCurrentPassword('');
    setNewPassword('');
    setConfirmation('');
    setNotice(
      'Mot de passe changé. Toutes les autres sessions ont été fermées ; celle-ci reste ouverte.',
    );
    setPending(false);
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Mot de passe</CardTitle>
        <CardDescription>
          L&apos;ancien mot de passe est exigé : sans lui, un cookie de session volé suffirait
          à s&apos;emparer du compte. Le changement ferme toutes les autres sessions ouvertes.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          {error ? <Alert variant="destructive">{error}</Alert> : null}
          {notice ? <Alert variant="success">{notice}</Alert> : null}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="current-password">Mot de passe actuel</Label>
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
            <Label htmlFor="new-password">Nouveau mot de passe</Label>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              required
              minLength={PASSWORD_MIN_LENGTH}
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
            <p className="text-xs text-ink-faint">{PASSWORD_MIN_LENGTH} caractères minimum.</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="confirm-password">Confirmation</Label>
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
            {pending ? 'Changement…' : 'Changer le mot de passe'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
