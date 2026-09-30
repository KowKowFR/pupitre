'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useState } from 'react';
import { useT } from '@/i18n/client';
import { auth as messages } from '@/i18n/messages/auth';
import { common } from '@/i18n/messages/common';
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

export function LoginForm({
  next,
  canRecoverPassword,
  signupOpen,
}: {
  next: string;
  /** L'instance sait-elle envoyer un e-mail ? Sinon le lien de secours est masqué. */
  canRecoverPassword: boolean;
  /** L'inscription est-elle ouverte ? Sinon le lien mènerait à un refus. */
  signupOpen: boolean;
}) {
  const t = useT(messages);
  const tc = useT(common);
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
      setError(t('login.rejected'));
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
      setError(useBackupCode ? t('twoFactor.error.backup') : t('twoFactor.error.totp'));
      setCode('');
      setPending(false);
      return;
    }

    router.push(next);
    router.refresh();
  }

  if (challenge) {
    return (
      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">{t('twoFactor.title')}</CardTitle>
          <CardDescription>
            {useBackupCode
              ? t('twoFactor.description.backup')
              : t('twoFactor.description.totp')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onVerify} className="flex flex-col gap-4">
            {error ? <Alert variant="destructive">{error}</Alert> : null}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="code">
                {useBackupCode ? t('twoFactor.field.backupCode') : t('twoFactor.field.code')}
              </Label>
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
              {pending ? tc('checking') : t('twoFactor.submit')}
            </Button>
            <button
              type="button"
              className="text-center text-xs text-text-2 underline-offset-4 hover:underline"
              onClick={() => {
                setUseBackupCode(!useBackupCode);
                setCode('');
                setError(null);
              }}
            >
              {useBackupCode ? t('twoFactor.useApp') : t('twoFactor.useBackup')}
            </button>
          </form>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle className="text-lg">{t('login.title')}</CardTitle>
        <CardDescription>{t('login.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          {error ? <Alert variant="destructive">{error}</Alert> : null}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">{t('field.email')}</Label>
            <Input id="email" name="email" type="email" autoComplete="email" required autoFocus />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">{t('field.password')}</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </div>
          <Button type="submit" className="mt-1 w-full" disabled={pending}>
            {pending ? t('login.pending') : t('login.submit')}
          </Button>
          {canRecoverPassword ? (
            <p className="text-center text-xs text-text-2">
              <Link
                href="/forgot-password"
                className="text-accent underline decoration-accent-line underline-offset-4 hover:decoration-accent"
              >
                {t('login.forgot')}
              </Link>
            </p>
          ) : null}
          <p className="text-center text-xs text-text-2">
            {signupOpen ? (
              <>
                {t('login.signup.prompt')}{' '}
                <Link
                  href="/signup"
                  className="text-accent underline decoration-accent-line underline-offset-4 hover:decoration-accent"
                >
                  {t('login.signup.link')}
                </Link>
                {t('login.signup.note')}
              </>
            ) : (
              <>{t('login.signup.closed')}</>
            )}
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
