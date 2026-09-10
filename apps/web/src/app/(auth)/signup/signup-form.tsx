'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { signUp } from '@/lib/auth-client';
import { PASSWORD_MIN_LENGTH } from '@/lib/password-policy';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function SignupForm() {
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
      setError(`Le mot de passe doit faire au moins ${PASSWORD_MIN_LENGTH} caractères.`);
      setPending(false);
      return;
    }

    const result = await signUp.email({
      name: String(form.get('name') ?? ''),
      email: String(form.get('email') ?? ''),
      password,
    });

    if (result.error) {
      setError(result.error.message ?? "L'inscription a échoué.");
      setPending(false);
      return;
    }

    router.push('/');
    router.refresh();
  }

  return (
    <Card className="shadow-raised">
      <CardHeader>
        <CardTitle className="text-lg">Créer un compte</CardTitle>
        <CardDescription>
          Le premier compte créé reçoit automatiquement le rôle administrateur.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          {error ? <Alert variant="destructive">{error}</Alert> : null}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name">Nom</Label>
            <Input id="name" name="name" autoComplete="name" required autoFocus />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">Adresse e-mail</Label>
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">Mot de passe</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={PASSWORD_MIN_LENGTH}
              required
            />
            <p className="text-xs text-ink-faint">{PASSWORD_MIN_LENGTH} caractères minimum.</p>
          </div>
          <Button type="submit" className="mt-1 w-full" disabled={pending}>
            {pending ? 'Création…' : 'Créer le compte'}
          </Button>
          <p className="text-center text-xs text-ink-muted">
            Déjà un compte ?{' '}
            <Link
              href="/login"
              className="text-signal underline decoration-signal-edge underline-offset-4 hover:decoration-signal"
            >
              Se connecter
            </Link>
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
