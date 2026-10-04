'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { KeyRound, ShieldCheck, Smartphone } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Field, OtpInput } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n/client';
import { account as messages } from '@/i18n/messages/account';
import { common } from '@/i18n/messages/common';
import { toast } from '@/lib/toast';
import { readApiError } from './api-error';

/**
 * The current step of the activation. The secret only exists in this state, in
 * the tab's memory: it is neither stored, nor read back from the server after
 * activation, nor logged anywhere.
 */
type Setup = { totpURI: string; secret: string; backupCodes: string[] };

/** Splits the secret into blocks of four — a manual entry without a typo. */
function groupSecret(secret: string): string {
  return secret.replace(/(.{4})/g, '$1 ').trim();
}

/** The secret travels in the query string of the `otpauth://` URI. */
function readSecret(totpURI: string): string {
  try {
    return new URL(totpURI).searchParams.get('secret') ?? '';
  } catch {
    return '';
  }
}

/**
 * `required`: the instance's policy requires it for this account. Absent, it is
 * enabled; present, it cannot be removed — the route would refuse it anyway
 * (`two_factor_locked`).
 */
export function TwoFactorPanel({ enabled, required }: { enabled: boolean; required: boolean }) {
  const t = useT(messages);
  const tc = useT(common);
  const router = useRouter();

  const [setup, setSetup] = useState<Setup | null>(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function startSetup(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
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
    toast({ title: t('twoFactor.enabled') });
    setPending(false);
    router.refresh();
  }

  async function disable(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
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
    toast({ title: t('twoFactor.disabled') });
    setPending(false);
    router.refresh();
  }

  return (
    <Card className="flex flex-col">
      <CardHeader
        actions={
          enabled ? (
            <Badge variant="ok" dot>
              {t('twoFactor.badge.on')}
            </Badge>
          ) : setup ? (
            <Badge variant="warn" dot>
              {t('twoFactor.badge.setup')}
            </Badge>
          ) : required ? (
            <Badge variant="warn" dot>
              {t('twoFactor.badge.required')}
            </Badge>
          ) : (
            <Badge>{t('twoFactor.badge.off')}</Badge>
          )
        }
      >
        <CardTitle>{t('twoFactor.title')}</CardTitle>
        <CardDescription>{t('twoFactor.description')}</CardDescription>
      </CardHeader>

      {enabled && required ? (
        <CardContent className="flex flex-1 flex-col gap-4">
          <p className="t-sm text-text-2">{t('twoFactor.locked.body')}</p>
        </CardContent>
      ) : enabled ? (
        <form onSubmit={disable} className="contents">
          <CardContent className="flex flex-1 flex-col gap-4">
            {error ? <Alert variant="destructive">{error}</Alert> : null}
            <p className="t-sm text-text-2">{t('twoFactor.armed.body')}</p>
            <Field label={t('twoFactor.field.password')}>
              <Input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
          </CardContent>
          <CardFooter>
            <Button type="submit" variant="destructive" loading={pending}>
              {pending ? t('twoFactor.disabling') : tc('disable')}
            </Button>
          </CardFooter>
        </form>
      ) : setup ? (
        <SetupSteps
          setup={setup}
          code={code}
          pending={pending}
          error={error}
          onCodeChange={setCode}
          onSubmit={activate}
          onCancel={() => {
            setSetup(null);
            setCode('');
          }}
        />
      ) : (
        <form onSubmit={startSetup} className="contents">
          <CardContent className="flex flex-1 flex-col gap-4">
            {error ? <Alert variant="destructive">{error}</Alert> : null}
            {/* What the second factor changes, before asking for the password: the color
                says the nature of each point, the icon and the text say it too. */}
            <ul className="flex flex-col gap-2.5">
              {(
                [
                  ['stolen', ShieldCheck, 'border-ok-line bg-ok-soft text-ok-text'],
                  ['code', Smartphone, 'border-accent-line bg-accent-soft text-accent-text'],
                  ['backup', KeyRound, 'border-warn-line bg-warn-soft text-warn-text'],
                ] as const
              ).map(([key, Icon, tone]) => (
                <li key={key} className="flex items-start gap-3">
                  <span
                    aria-hidden
                    className={`grid size-7 shrink-0 place-items-center rounded-lg border ${tone}`}
                  >
                    <Icon className="size-4" />
                  </span>
                  <span className="t-sm pt-1 text-text-2">{t(`twoFactor.why.${key}`)}</span>
                </li>
              ))}
            </ul>
            <Field label={t('twoFactor.field.password')}>
              <Input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
          </CardContent>
          <CardFooter>
            <Button type="submit" loading={pending}>
              {pending ? t('twoFactor.generating') : t('twoFactor.enable')}
            </Button>
          </CardFooter>
        </form>
      )}
    </Card>
  );
}

function SetupSteps({
  setup,
  code,
  pending,
  error,
  onCodeChange,
  onSubmit,
  onCancel,
}: {
  setup: Setup;
  code: string;
  pending: boolean;
  error: string | null;
  onCodeChange: (value: string) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  const t = useT(messages);
  const tc = useT(common);

  return (
    <form onSubmit={onSubmit} className="contents">
      <CardContent className="flex flex-col gap-4">
        {error ? <Alert variant="destructive">{error}</Alert> : null}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4">
          {/* The QR code is drawn in the page: it never leaves the browser. */}
          <div className="w-fit shrink-0 rounded-lg border border-border bg-white p-2.5">
            <QRCodeSVG value={setup.totpURI} size={112} level="M" marginSize={0} />
          </div>
          <div className="flex min-w-0 flex-col gap-2">
            <p className="t-sm text-text-2">{t('setup.scan')}</p>
            <span className="t-cap text-text-3">{t('setup.key')}</span>
            <code className="codeblock break-all whitespace-normal">
              {groupSecret(setup.secret)}
            </code>
          </div>
        </div>

        <Alert variant="warn" title={t('setup.backup.title')}>
          {t('setup.backup.body')}
        </Alert>

        <ul className="grid grid-cols-2 gap-1.5 sm:grid-cols-5">
          {setup.backupCodes.map((backupCode) => (
            <li
              key={backupCode}
              className="mono rounded-md bg-surface-2 px-2 py-1.5 text-center text-[12.5px] text-text"
            >
              {backupCode}
            </li>
          ))}
        </ul>

        <div className="field">
          <span className="label" id="totp-code-label">
            {t('setup.code.label')}
          </span>
          <OtpInput value={code} onChange={onCodeChange} name="code" autoFocus />
          <p className="help">{t('setup.code.hint')}</p>
        </div>
      </CardContent>
      <CardFooter>
        <Button type="submit" loading={pending} disabled={code.length !== 6}>
          {pending ? tc('checking') : t('setup.submit')}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          {tc('cancel')}
        </Button>
      </CardFooter>
    </form>
  );
}
