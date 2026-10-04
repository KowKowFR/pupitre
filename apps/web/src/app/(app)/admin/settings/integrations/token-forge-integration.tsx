'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ArrowUpRight, GitFork, KeyRound, Unplug } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { KeyValue } from '@/components/ui/data';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useLanguage, useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { sources as messages } from '@/i18n/messages/sources';
import type { TokenForgeConnectionView } from '@/lib/sources';
import type { TokenForgeKind } from '@/lib/token-forges';
import { toast } from '@/lib/toast';

type ApiError = { error?: { message?: string } };
type Check =
  | { ok: true; login: string; version: string; baseUrl: string; expiresAt: string | null }
  | { ok: false; error: string }
  | null;

/**
 * Une forge à jeton de l'instance — Gitea / Forgejo, ou GitLab : la connecter
 * par l'adresse et un jeton, voir à quel compte elle ouvre, remplacer le
 * jeton, la déconnecter.
 *
 * Pas de manifeste ici, contrairement à GitHub : ni Gitea ni GitLab n'ont
 * d'équivalent des Apps. Le jeton est essayé avant d'être enregistré, et ne
 * revient jamais.
 */
export function TokenForgeIntegration({
  kind,
  connection,
  sourcesCount,
  canManage,
}: {
  kind: TokenForgeKind;
  connection: TokenForgeConnectionView | null;
  sourcesCount: number;
  canManage: boolean;
}) {
  const t = useT(messages);
  const [replacing, setReplacing] = useState(false);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <span
          aria-hidden
          className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-surface-2 text-text-2"
        >
          <GitFork className="size-4" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-2 font-semibold text-text">
            {t(`${kind}.title`)}
            <Badge variant={connection ? 'ok' : 'idle'} dot>
              {connection ? t('forge.state.on') : t('forge.state.off')}
            </Badge>
          </span>
          <span className="t-sm text-text-2">{t(`${kind}.lead`)}</span>
        </div>
      </div>

      {connection && !replacing ? (
        <Connected
          kind={kind}
          connection={connection}
          sourcesCount={sourcesCount}
          canManage={canManage}
          onReplace={() => setReplacing(true)}
        />
      ) : canManage ? (
        <ConnectForm
          kind={kind}
          initialUrl={connection?.url ?? ''}
          replacing={connection !== null}
          onDone={() => setReplacing(false)}
        />
      ) : null}
    </div>
  );
}

function Connected({
  kind,
  connection,
  sourcesCount,
  canManage,
  onReplace,
}: {
  kind: TokenForgeKind;
  connection: TokenForgeConnectionView;
  sourcesCount: number;
  canManage: boolean;
  onReplace: () => void;
}) {
  const t = useT(messages);
  const c = useT(common);
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function disconnect() {
    setPending(true);
    setError(null);
    const response = await fetch(`/api/integrations/${kind}`, { method: 'DELETE' });
    setPending(false);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      setError(body.error?.message ?? c('http.failure', { status: response.status }));
      return;
    }
    setConfirming(false);
    toast({ title: t('forge.disconnected'), tone: 'ok' });
    router.refresh();
  }

  return (
    <>
      <KeyValue
        items={[
          {
            key: 'forge',
            term: t('forge.forge'),
            value: (
              <a href={connection.url} target="_blank" rel="noreferrer" className="link mono">
                {connection.url}
              </a>
            ),
          },
          {
            key: 'account',
            term: t('forge.account'),
            value: <span className="mono">{connection.account}</span>,
          },
        ]}
      />
      <p className="t-cap text-text-3">{t('forge.sources', { count: sourcesCount })}</p>

      {canManage ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={onReplace}>
            <KeyRound aria-hidden />
            {t('forge.replace')}
          </Button>
          <Button asChild variant="ghost">
            <a href={connection.url} target="_blank" rel="noreferrer">
              {connection.name}
              <ArrowUpRight aria-hidden />
            </a>
          </Button>
          <Button
            variant="ghost"
            className="ml-auto text-danger-text"
            onClick={() => {
              setError(null);
              setConfirming(true);
            }}
          >
            <Unplug aria-hidden />
            {t('forge.disconnect')}
          </Button>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        level="trace"
        icon={<Unplug />}
        title={t('forge.disconnect.title', { url: connection.url })}
        consequences={[
          t('forge.disconnect.sources', { count: sourcesCount }),
          t('forge.disconnect.history'),
          t('forge.disconnect.token'),
        ]}
        confirmLabel={t('forge.disconnect')}
        pending={pending}
        error={error}
        onConfirm={disconnect}
      />
    </>
  );
}

function ConnectForm({
  kind,
  initialUrl,
  replacing,
  onDone,
}: {
  kind: TokenForgeKind;
  initialUrl: string;
  replacing: boolean;
  onDone: () => void;
}) {
  const t = useT(messages);
  const c = useT(common);
  const language = useLanguage();
  const router = useRouter();
  const [url, setUrl] = useState(initialUrl);
  const [token, setToken] = useState('');
  const [check, setCheck] = useState<Check>(null);
  const [checking, setChecking] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = url.trim() !== '' && token.trim().length >= 8;

  async function test() {
    setChecking(true);
    setCheck(null);
    const response = await fetch(`/api/integrations/${kind}/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: url.trim(), token: token.trim() }),
    }).catch(() => null);
    setChecking(false);
    const body = (await response?.json().catch(() => null)) as Check | ApiError | null;
    if (body && 'ok' in body) setCheck(body);
    else {
      setCheck({
        ok: false,
        error:
          (body && 'error' in body && body.error?.message) ||
          c('http.failure', { status: response?.status ?? 0 }),
      });
    }
  }

  async function save() {
    setPending(true);
    setError(null);
    const response = await fetch(`/api/integrations/${kind}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: url.trim(), token: token.trim() }),
    });
    setPending(false);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      setError(body.error?.message ?? c('http.failure', { status: response.status }));
      return;
    }
    setToken('');
    toast({ title: replacing ? t('forge.replaced') : t('forge.connected'), tone: 'ok' });
    onDone();
    router.refresh();
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) void save();
      }}
    >
      {error ? <Alert variant="destructive">{error}</Alert> : null}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={t('forge.url')} help={t(`${kind}.url.help`)} htmlFor={`${kind}-url`}>
          <Input
            id={`${kind}-url`}
            type="url"
            value={url}
            placeholder={t(`${kind}.url.placeholder`)}
            className="mono"
            onChange={(event) => {
              setUrl(event.target.value);
              setCheck(null);
            }}
          />
        </Field>
        <Field label={t('forge.token')} help={t(`${kind}.token.help`)} htmlFor={`${kind}-token`}>
          <Input
            id={`${kind}-token`}
            type="password"
            autoComplete="off"
            value={token}
            className="mono"
            onChange={(event) => {
              setToken(event.target.value);
              setCheck(null);
            }}
          />
        </Field>
      </div>
      {check ? (
        <Alert variant={check.ok ? 'success' : 'destructive'}>
          {check.ok
            ? t('forge.check.ok', { login: check.login, version: check.version })
            : t('forge.check.failed', { error: check.error })}
          {check.ok && check.expiresAt
            ? ` ${t('forge.check.expires', {
                date: new Intl.DateTimeFormat(language, {
                  dateStyle: 'long',
                  timeZone: 'UTC',
                }).format(new Date(`${check.expiresAt}T00:00:00Z`)),
              })}`
            : null}
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" loading={pending} disabled={!ready}>
          {replacing ? t('forge.replace') : t('forge.connect')}
        </Button>
        <Button
          type="button"
          variant="secondary"
          loading={checking}
          disabled={!ready}
          onClick={() => void test()}
        >
          {t('forge.check')}
        </Button>
        {replacing ? (
          <Button type="button" variant="ghost" onClick={onDone}>
            {c('cancel')}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
