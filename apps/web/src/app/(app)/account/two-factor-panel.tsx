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
      setError(await readApiError(response));
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
      setError(await readApiError(response));
      setPending(false);
      return;
    }

    setSetup(null);
    setCode('');
    setNotice('Second facteur activé. Il sera demandé à chaque connexion.');
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
      setError(await readApiError(response));
      setPending(false);
      return;
    }

    setPassword('');
    setNotice('Second facteur désactivé. La connexion ne demande plus que le mot de passe.');
    setPending(false);
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Double authentification (TOTP)
          {enabled ? <Badge variant="ok">active</Badge> : <Badge variant="secondary">inactive</Badge>}
        </CardTitle>
        <CardDescription>
          Un code à six chiffres, renouvelé toutes les trente secondes par une application
          d&apos;authentification. Le QR code est dessiné dans cette page : le secret ne part
          chez personne.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {error ? <Alert variant="destructive">{error}</Alert> : null}
        {notice ? <Alert variant="success">{notice}</Alert> : null}

        {enabled ? (
          <form onSubmit={disable} className="flex flex-col gap-4">
            <p className="text-[0.8125rem] text-ink-muted">
              Chaque connexion réclame un code. Pour retirer ce facteur, confirmez avec votre
              mot de passe.
            </p>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="disable-password">Mot de passe</Label>
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
              {pending ? 'Désactivation…' : 'Désactiver'}
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
              <Label htmlFor="setup-password">Mot de passe</Label>
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
              {pending ? 'Génération…' : 'Activer le second facteur'}
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
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-5">
        <div className="w-fit shrink-0 rounded-md border border-line bg-white p-3">
          <QRCodeSVG value={setup.totpURI} size={148} level="M" marginSize={0} />
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <p className="text-[0.8125rem] leading-relaxed text-ink-muted">
            Scannez ce code, ou saisissez la clé à la main si votre application ne peut pas
            lire de QR.
          </p>
          <div className="flex flex-col gap-1">
            <Label>Clé de configuration</Label>
            <code className="rounded-sm border border-line bg-surface-2 px-2 py-1.5 font-mono text-xs break-all text-ink">
              {groupSecret(setup.secret)}
            </code>
          </div>
        </div>
      </div>

      <Alert variant="warn">
        <strong className="font-medium">Codes de secours — affichés une seule fois.</strong> Ils
        ne seront plus jamais montrés. Notez-les hors de cette machine : ce sont les seules
        clés qui rouvriront le compte si vous perdez votre téléphone. Chacun ne sert
        qu&apos;une fois.
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
          <Label htmlFor="totp-code">Code affiché par l&apos;application</Label>
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
          <p className="text-xs text-ink-faint">
            Le second facteur n&apos;est armé qu&apos;après ce premier code valide.
          </p>
        </div>
        <div className="flex gap-2">
          <Button type="submit" disabled={pending}>
            {pending ? 'Vérification…' : 'Vérifier et activer'}
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
            Annuler
          </Button>
        </div>
      </form>
    </div>
  );
}
