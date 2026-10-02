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
import { Field, OtpInput } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { AuthCard } from '../auth-card';

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

/** Les refus que Better Auth renvoie au retour du fournisseur, et qu'on sait dire en clair. */
const SSO_ERRORS = ['signup_disabled', 'account_not_linked', 'banned'] as const;

export function LoginForm({
  next,
  canRecoverPassword,
  signupOpen,
  sso,
  ssoError,
}: {
  next: string;
  /** L'instance sait-elle envoyer un e-mail ? Sinon le lien de secours est masqué. */
  canRecoverPassword: boolean;
  /** L'inscription est-elle ouverte ? Sinon le lien mènerait à un refus. */
  signupOpen: boolean;
  /** La connexion unique, quand elle est active et que son fournisseur répond. */
  sso: { label: string } | null;
  /** Le code d'erreur d'un retour du fournisseur (`?error=`), s'il y en a un. */
  ssoError: string | null;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const router = useRouter();
  const [challenge, setChallenge] = useState(false);
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [redirecting, setRedirecting] = useState(false);

  // Better Auth écrit ses codes tantôt en minuscules (`signup_disabled`),
  // tantôt en majuscules (`BANNED_USER`) : on les ramène à une forme.
  const ssoCode = ssoError?.toLowerCase().replace(/^banned_user$/, 'banned') ?? null;
  const ssoMessage = ssoCode
    ? (SSO_ERRORS as readonly string[]).includes(ssoCode)
      ? t(`login.sso.error.${ssoCode as (typeof SSO_ERRORS)[number]}`)
      : t('login.sso.error.generic', { error: ssoError ?? '' })
    : null;

  /**
   * Better Auth rend l'adresse du fournisseur (état et PKCE déjà posés dans un
   * cookie) ; le navigateur y part. Au retour, la session est posée et l'on
   * arrive sur `next` — ou sur `/login?error=…` si quelque chose a refusé.
   */
  async function signInWithSso() {
    setRedirecting(true);
    setError(null);
    const response = await fetch('/api/auth/sign-in/social', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'oidc', callbackURL: next, errorCallbackURL: '/login' }),
    }).catch(() => null);
    const body = (await response?.json().catch(() => null)) as { url?: string } | null;
    if (!response?.ok || !body?.url) {
      setRedirecting(false);
      setError(t('login.sso.error.generic', { error: String(response?.status ?? '—') }));
      return;
    }
    window.location.href = body.url;
  }

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
      <AuthCard
        title={t('twoFactor.title')}
        description={
          useBackupCode ? t('twoFactor.description.backup') : t('twoFactor.description.totp')
        }
      >
        <form onSubmit={onVerify} className="flex flex-col gap-4">
          {error ? <Alert variant="destructive">{error}</Alert> : null}
          {useBackupCode ? (
            <Field label={t('twoFactor.field.backupCode')}>
              <Input
                name="code"
                autoComplete="one-time-code"
                autoFocus
                required
                className="mono"
                value={code}
                onChange={(event) => setCode(event.target.value.trim())}
              />
            </Field>
          ) : (
            <>
              <OtpInput
                value={code}
                onChange={setCode}
                autoFocus
                className="is-lg justify-center"
              />
              <p className="help text-center">{t('twoFactor.clock')}</p>
            </>
          )}
          <Button
            type="submit"
            size="lg"
            className="btn-block"
            loading={pending}
            disabled={!useBackupCode && code.length !== 6}
          >
            {pending ? tc('checking') : t('twoFactor.submit')}
          </Button>
          {!useBackupCode && code.length !== 6 ? (
            <p className="t-cap text-center text-text-3">{t('twoFactor.sixth')}</p>
          ) : null}
          <button
            type="button"
            className="btn btn-link t-sm self-center"
            onClick={() => {
              setUseBackupCode(!useBackupCode);
              setCode('');
              setError(null);
            }}
          >
            {useBackupCode ? t('twoFactor.useApp') : t('twoFactor.useBackup')}
          </button>
        </form>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title={t('login.title')}
      description={sso ? t('login.description.sso', { label: sso.label }) : t('login.description')}
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        {error ? <Alert variant="destructive">{error}</Alert> : null}
        {ssoMessage && !error ? <Alert variant="destructive">{ssoMessage}</Alert> : null}
        {sso ? (
          <>
            <Button
              type="button"
              size="lg"
              variant="secondary"
              className="btn-block"
              loading={redirecting}
              onClick={() => void signInWithSso()}
            >
              {redirecting ? t('login.sso.pending') : t('login.sso', { label: sso.label })}
            </Button>
            <p className="t-cap text-center text-text-3">{t('login.sso.or')}</p>
          </>
        ) : null}
        <Field label={t('field.email')}>
          <Input name="email" type="email" autoComplete="email" required autoFocus={!sso} />
        </Field>
        <div className="field">
          <span className="flex items-center">
            <label htmlFor="password" className="label">
              {t('field.password')}
            </label>
            {canRecoverPassword ? (
              <Link href="/forgot-password" className="link t-cap ml-auto">
                {t('login.forgot')}
              </Link>
            ) : null}
          </span>
          <span className="affix has-end">
            <Input
              id="password"
              name="password"
              type={reveal ? 'text' : 'password'}
              autoComplete="current-password"
              required
              aria-invalid={error ? true : undefined}
              className="!pl-3"
            />
            <span className="affix-end">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-pressed={reveal}
                onClick={() => setReveal((current) => !current)}
              >
                {reveal ? t('field.password.hide') : t('field.password.show')}
              </Button>
            </span>
          </span>
        </div>
        <Button type="submit" size="lg" className="btn-block" loading={pending}>
          {pending ? t('login.pending') : t('login.submit')}
        </Button>
        <hr className="sep" />
        <p className="t-cap text-center text-text-3">
          {signupOpen ? (
            <>
              {t('login.signup.prompt')}{' '}
              <Link href="/signup" className="link">
                {t('login.signup.link')}
              </Link>
              {t('login.signup.note')}
            </>
          ) : (
            <>{t('login.signup.closed')}</>
          )}
        </p>
      </form>
    </AuthCard>
  );
}
