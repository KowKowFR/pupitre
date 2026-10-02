'use client';

import { useState } from 'react';
import { Network } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Drawer,
  DrawerBody,
  DrawerDanger,
  DrawerFooter,
  DrawerHeader,
  DrawerSection,
} from '@/components/ui/drawer';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { proxy as messages } from '@/i18n/messages/proxy';
import type { ProxyCheckResult, RemoteProxyViewForUi } from '@/lib/proxy';
import { toast } from '@/lib/toast';

type ApiError = { error?: { message?: string } };
type Entrypoint = { host: string; httpPort: number; httpsPort: number } | null;

/**
 * Connecter un Nginx Proxy Manager, ou modifier sa connexion. Un proxy hors
 * des cibles : Pupitre lui parle par son API, avec un compte à lui. Le test
 * part à l'enregistrement — une connexion neuve qui n'entre pas n'est pas
 * gardée, et la raison est dite ici même.
 */
export function NpmConnectionDrawer({
  open,
  onClose,
  connection,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  /** `null` : une nouvelle connexion. */
  connection: RemoteProxyViewForUi | null;
  /** Après l'enregistrement — ou `null` après le retrait. */
  onSaved: (proxyId: string | null) => void;
}) {
  const t = useT(messages);
  const title = connection ? t('npm.title.edit') : t('npm.title.new');
  return (
    <Drawer open={open} onOpenChange={(next) => (next ? undefined : onClose())} label={title}>
      {open ? (
        <>
          <DrawerHeader
            icon={<Network />}
            kind={t('npm.kind')}
            route={connection?.name}
            title={title}
            extra={<p className="t-sm text-text-2">{t('npm.lead')}</p>}
          />
          <NpmForm
            key={connection?.id ?? 'new'}
            connection={connection}
            onDone={onClose}
            onSaved={onSaved}
          />
        </>
      ) : null}
    </Drawer>
  );
}

function NpmForm({
  connection,
  onDone,
  onSaved,
}: {
  connection: RemoteProxyViewForUi | null;
  onDone: () => void;
  onSaved: (proxyId: string | null) => void;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const config = (connection?.config ?? {}) as {
    url?: string;
    email?: string;
    entrypoint?: Entrypoint;
  };
  const [name, setName] = useState(connection?.name ?? '');
  const [url, setUrl] = useState(config.url ?? '');
  const [email, setEmail] = useState(config.email ?? '');
  const [password, setPassword] = useState('');
  const [entryHost, setEntryHost] = useState(config.entrypoint?.host ?? '');
  const [httpPort, setHttpPort] = useState(String(config.entrypoint?.httpPort ?? 80));
  const [httpsPort, setHttpsPort] = useState(String(config.entrypoint?.httpsPort ?? 443));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  const invalid =
    url.trim() === ''
      ? t('npm.invalid.url')
      : email.trim() === ''
        ? t('npm.invalid.email')
        : connection === null && password === ''
          ? t('npm.invalid.password')
          : null;

  function problemsOf(check: ProxyCheckResult): string {
    return check.checks
      .filter((item) => !item.ok)
      .map((item) => `${item.label} : ${item.detail ?? ''}`)
      .join(' · ');
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (invalid) return;
    setPending(true);
    setError(null);
    const body = {
      kind: 'npm',
      ...(name.trim() ? { name: name.trim() } : {}),
      config: {
        url: url.trim(),
        email: email.trim(),
        entrypoint: entryHost.trim()
          ? {
              host: entryHost.trim(),
              httpPort: Number(httpPort) || 80,
              httpsPort: Number(httpsPort) || 443,
            }
          : null,
      },
      // En modification, un mot de passe vide garde celui enregistré.
      ...(password !== '' ? { secrets: { password } } : {}),
    };
    const response = await fetch(connection ? `/api/proxies/${connection.id}` : '/api/proxies', {
      method: connection ? 'PATCH' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => null);
    setPending(false);
    if (!response?.ok) {
      const failure = response ? ((await response.json().catch(() => ({}))) as ApiError) : {};
      setError(failure.error?.message ?? tc('http.failure', { status: response?.status ?? 0 }));
      return;
    }
    const saved = (await response.json()) as {
      proxy: RemoteProxyViewForUi | null;
      check?: ProxyCheckResult | null;
    };
    if (saved.check && !saved.check.ok) {
      // Enregistrée quand même : on reste ici, avec ce qui ne va pas.
      setError(t('npm.checkFailed', { problems: problemsOf(saved.check) }));
      onSaved(saved.proxy?.id ?? connection?.id ?? null);
      return;
    }
    toast({ title: connection ? t('npm.updated') : t('npm.connected'), tone: 'ok' });
    onSaved(saved.proxy?.id ?? null);
    onDone();
  }

  async function remove() {
    if (!connection) return;
    setRemoving(false);
    const response = await fetch(`/api/proxies/${connection.id}`, { method: 'DELETE' }).catch(
      () => null,
    );
    if (!response?.ok) {
      const failure = response ? ((await response.json().catch(() => ({}))) as ApiError) : {};
      setError(failure.error?.message ?? tc('http.failure', { status: response?.status ?? 0 }));
      return;
    }
    toast({ title: t('npm.removed'), tone: 'ok' });
    onSaved(null);
    onDone();
  }

  return (
    <form onSubmit={onSubmit} className="contents">
      <DrawerBody>
        {error ? <Alert variant="destructive">{error}</Alert> : null}

        <DrawerSection title={t('npm.section.api')}>
          <Field label={t('npm.url')} help={t('npm.url.help')}>
            <Input
              className="mono"
              value={url}
              placeholder="http://10.0.0.5:81"
              autoComplete="off"
              onChange={(event) => setUrl(event.target.value)}
            />
          </Field>
          <Field label={t('npm.name')} help={t('npm.name.help')}>
            <Input
              value={name}
              placeholder="Nginx Proxy Manager"
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
        </DrawerSection>

        <DrawerSection title={t('npm.section.account')}>
          <p className="help">{t('npm.account.help')}</p>
          <Field label={t('npm.email')}>
            <Input
              type="email"
              value={email}
              placeholder="pupitre@exemple.fr"
              autoComplete="off"
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>
          <Field label={t('npm.password')} help={connection ? t('npm.password.keep') : undefined}>
            <Input
              type="password"
              value={password}
              autoComplete="new-password"
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
        </DrawerSection>

        <DrawerSection title={t('npm.section.entrypoint')}>
          <p className="help">{t('npm.entrypoint.help')}</p>
          <Field label={t('npm.entrypoint.host')}>
            <Input
              className="mono"
              value={entryHost}
              placeholder={url ? safeHost(url) : '203.0.113.10'}
              onChange={(event) => setEntryHost(event.target.value)}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('npm.entrypoint.http')}>
              <Input
                className="mono"
                inputMode="numeric"
                value={httpPort}
                disabled={!entryHost.trim()}
                onChange={(event) => setHttpPort(event.target.value)}
              />
            </Field>
            <Field label={t('npm.entrypoint.https')}>
              <Input
                className="mono"
                inputMode="numeric"
                value={httpsPort}
                disabled={!entryHost.trim()}
                onChange={(event) => setHttpsPort(event.target.value)}
              />
            </Field>
          </div>
        </DrawerSection>

        {connection ? (
          <DrawerDanger>
            <div className="flex items-center gap-3">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="t-sm font-semibold">{t('npm.remove')}</span>
                <span className="t-cap text-text-3">{t('npm.remove.help')}</span>
              </div>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => setRemoving(true)}
              >
                {tc('delete')}
              </Button>
            </div>
          </DrawerDanger>
        ) : null}
      </DrawerBody>
      <DrawerFooter end={null}>
        <Button type="submit" loading={pending} disabledReason={invalid}>
          {pending ? t('npm.testing') : connection ? t('npm.submit.edit') : t('npm.submit.new')}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          {tc('cancel')}
        </Button>
      </DrawerFooter>

      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        level="reversible"
        title={t('npm.remove')}
        consequences={[t('npm.remove.help')]}
        confirmLabel={tc('delete')}
        onConfirm={remove}
      />
    </form>
  );
}

/** L'hôte d'une adresse saisie, pour le proposer — sans casser sur une saisie en cours. */
function safeHost(value: string): string {
  try {
    return new URL(value.trim()).hostname;
  } catch {
    return '203.0.113.10';
  }
}
