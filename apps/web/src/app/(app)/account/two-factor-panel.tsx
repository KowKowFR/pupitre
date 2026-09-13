'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useT } from '@/i18n/client';
import { account as messages } from '@/i18n/messages/account';
import { common } from '@/i18n/messages/common';
import { readApiError } from './api-error';

/**
 * Étape courante de l'activation. Le secret n'existe que dans cet état, en
 * mémoire de l'onglet : il n'est ni stocké, ni relu depuis le serveur après
 * l'activation, ni journalisé nulle part.
 */
type Setup = { totpURI: string; secret: string; backupCodes: string[] };

/** Découpe le secret en blocs de quatre — une saisie manuelle sans faute de frappe. */
function groupSecret(secret: string): string {
  return secret.replace(/(.{4})/g, '$1 ').trim();
}

/** Le secret voyage dans la query string de l'URI `otpauth://`. */
function readSecret(totpURI: string): string {
  try {
    return new URL(totpURI).searchParams.get('secret') ?? '';
  } catch {
    return '';
  }
}

export function TwoFactorPanel({ enabled }: { enabled: boolean }) {
  const t = useT(messages);
  const tc = useT(common);
  const router = useRouter();

  const [setup, setSetup] = useState<Setup | null>(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function startSetup(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setPending(true);

    const response = await fetch('/api/account/two-factor/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });

    if (!response.ok) {
      setError(await readApiError(response, t('error.http', { status: response.status })));
      setPending(false);
      return;
    }

    const payload = (await response.json()) as { totpURI: string; backupCodes: string[] };
    setSetup({
      totpURI: payload.totpURI,
      secret: readSecret(payload.totpURI),
      backupCodes: payload.backupCodes,
    });
    setPassword('');
    setPending(false);
  }

  async function activate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);

    const response = await fetch('/api/account/two-factor/activate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });

    if (!response.ok) {
      setError(await readApiError(response, t('error.http', { status: response.status })));
      setPending(false);
      return;
    }

    setSetup(null);
    setCode('');
    setNotice(t('twoFactor.enabled'));
    setPending(false);
    router.refresh();
  }

  async function disable(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setPending(true);

    const response = await fetch('/api/account/two-factor/disable', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });

    if (!response.ok) {
      setError(await readApiError(response, t('error.http', { status: response.status })));
      setPending(false);
      return;
    }

    setPassword('');
    setNotice(t('twoFactor.disabled'));
    setPending(false);
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {t('twoFactor.title')}
          {enabled ? (
            <Badge variant="ok">{t('twoFactor.badge.on')}</Badge>
          ) : (
            <Badge variant="secondary">{t('twoFactor.badge.off')}</Badge>
          )}
        </CardTitle>
        <CardDescription>{t('twoFactor.description')}</CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {error ? <Alert variant="destructive">{error}</Alert> : null}
        {notice ? <Alert variant="success">{notice}</Alert> : null}

        {enabled ? (
          <form onSubmit={disable} className="flex flex-col gap-4">
            <p className="text-[0.8125rem] text-ink-muted">{t('twoFactor.armed.body')}</p>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="disable-password">{t('twoFactor.field.password')}</Label>
              <Input
                id="disable-password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            <Button type="submit" variant="destructive" disabled={pending} className="self-start">
              {pending ? t('twoFactor.disabling') : tc('disable')}
            </Button>
          </form>
        ) : setup ? (
          <SetupSteps
            setup={setup}
            code={code}
            pending={pending}
            onCodeChange={setCode}
            onSubmit={activate}
            onCancel={() => {
              setSetup(null);
              setCode('');
            }}
          />
        ) : (
          <form onSubmit={startSetup} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="setup-password">{t('twoFactor.field.password')}</Label>
              <Input
                id="setup-password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            <Button type="submit" disabled={pending} className="self-start">
              {pending ? t('twoFactor.generating') : t('twoFactor.enable')}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

function SetupSteps({
  setup,
  code,
  pending,
  onCodeChange,
  onSubmit,
  onCancel,
}: {
  setup: Setup;
  code: string;
  pending: boolean;
  onCodeChange: (value: string) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  const t = useT(messages);
  const tc = useT(common);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-5">
        <div className="w-fit shrink-0 rounded-md border border-line bg-white p-3">
          <QRCodeSVG value={setup.totpURI} size={148} level="M" marginSize={0} />
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <p className="text-[0.8125rem] leading-relaxed text-ink-muted">{t('setup.scan')}</p>
          <div className="flex flex-col gap-1">
            <Label>{t('setup.key')}</Label>
            <code className="rounded-sm border border-line bg-surface-2 px-2 py-1.5 font-mono text-xs break-all text-ink">
              {groupSecret(setup.secret)}
            </code>
          </div>
        </div>
      </div>

      <Alert variant="warn">
        <strong className="font-medium">{t('setup.backup.title')}</strong> {t('setup.backup.body')}
      </Alert>

      <ul className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
        {setup.backupCodes.map((backupCode) => (
          <li
            key={backupCode}
            className="rounded-sm border border-line bg-surface-2 px-2 py-1 text-center font-mono text-xs text-ink"
          >
            {backupCode}
          </li>
        ))}
      </ul>

      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="totp-code">{t('setup.code.label')}</Label>
          <Input
            id="totp-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            required
            autoFocus
            placeholder="000000"
            className="w-40 font-mono tracking-[0.3em]"
            value={code}
            onChange={(event) => onCodeChange(event.target.value.replace(/\D/g, ''))}
          />
          <p className="text-xs text-ink-faint">{t('setup.code.hint')}</p>
        </div>
        <div className="flex gap-2">
          <Button type="submit" disabled={pending}>
            {pending ? tc('checking') : t('setup.submit')}
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
            {tc('cancel')}
          </Button>
        </div>
      </form>
    </div>
  );
}
