'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useState } from 'react';
import { signIn, twoFactor } from '@/lib/auth-client';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * Quand un compte porte un second facteur, Better Auth ne pose pas de session
 * à la connexion : il répond 200 avec `twoFactorRedirect` et un cookie de défi
 * de courte durée. Le mot de passe seul ne vaut donc plus rien.
 */
function needsSecondFactor(data: unknown): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    'twoFactorRedirect' in data &&
    (data as { twoFactorRedirect?: unknown }).twoFactorRedirect === true
  );
}

export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [challenge, setChallenge] = useState(false);
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const form = new FormData(event.currentTarget);
    const result = await signIn.email({
      email: String(form.get('email') ?? ''),
      password: String(form.get('password') ?? ''),
    });

    if (result.error) {
      // Message volontairement générique : ne pas révéler si le compte existe.
      setError('Identifiants invalides.');
      setPending(false);
      return;
    }

    if (needsSecondFactor(result.data)) {
      setChallenge(true);
      setPending(false);
      return;
    }

    router.push(next);
    router.refresh();
  }

  async function onVerify(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const result = useBackupCode
      ? await twoFactor.verifyBackupCode({ code })
      : await twoFactor.verifyTotp({ code });

    if (result.error) {
      setError(
        useBackupCode
          ? 'Code de secours invalide ou déjà utilisé.'
          : "Code invalide. Vérifiez l'horloge de votre téléphone, puis réessayez.",
      );
      setCode('');
      setPending(false);
      return;
    }

    router.push(next);
    router.refresh();
  }

  if (challenge) {
    return (
      <Card className="shadow-raised">
        <CardHeader>
          <CardTitle className="text-lg">Second facteur</CardTitle>
          <CardDescription>
            {useBackupCode
              ? 'Saisissez un code de secours. Chacun ne fonctionne qu’une seule fois.'
              : "Saisissez le code à six chiffres affiché par votre application d'authentification."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onVerify} className="flex flex-col gap-4">
            {error ? <Alert variant="destructive">{error}</Alert> : null}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="code">{useBackupCode ? 'Code de secours' : 'Code'}</Label>
              <Input
                id="code"
                name="code"
                inputMode={useBackupCode ? 'text' : 'numeric'}
                autoComplete="one-time-code"
                autoFocus
                required
                placeholder={useBackupCode ? '' : '000000'}
                className="font-mono"
                value={code}
                onChange={(event) => setCode(event.target.value.trim())}
              />
            </div>
            <Button type="submit" className="mt-1 w-full" disabled={pending}>
              {pending ? 'Vérification…' : 'Valider'}
            </Button>
            <button
              type="button"
              className="text-center text-xs text-ink-muted underline-offset-4 hover:underline"
              onClick={() => {
                setUseBackupCode(!useBackupCode);
                setCode('');
                setError(null);
              }}
            >
              {useBackupCode
                ? 'Utiliser le code de mon application'
                : 'Utiliser un code de secours'}
            </button>
          </form>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="shadow-raised">
      <CardHeader>
        <CardTitle className="text-lg">Connexion</CardTitle>
        <CardDescription>Accès réservé aux opérateurs déclarés.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          {error ? <Alert variant="destructive">{error}</Alert> : null}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">Adresse e-mail</Label>
            <Input id="email" name="email" type="email" autoComplete="email" required autoFocus />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">Mot de passe</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </div>
          <Button type="submit" className="mt-1 w-full" disabled={pending}>
            {pending ? 'Connexion…' : 'Se connecter'}
          </Button>
          <p className="text-center text-xs text-ink-muted">
            Pas de compte ?{' '}
            <Link
              href="/signup"
              className="text-signal underline decoration-signal-edge underline-offset-4 hover:decoration-signal"
            >
              Créer le premier administrateur
            </Link>
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
