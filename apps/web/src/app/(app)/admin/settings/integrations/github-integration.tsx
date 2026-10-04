'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ArrowUpRight, GitBranch, Unplug } from 'lucide-react';
import type { GitHubInstallation } from '@pupitre/core/sources';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { KeyValue } from '@/components/ui/data';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented';
import { useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { sources as messages } from '@/i18n/messages/sources';
import type { GitHubConnectionView } from '@/lib/sources';
import { toast } from '@/lib/toast';

type ApiError = { error?: { message?: string } };

/**
 * The instance's GitHub App: create it, connect it, see where it is installed,
 * disconnect it.
 *
 * Creation goes through a **manifest**: the browser posts the App's description
 * to GitHub, GitHub shows it to the operator, then sends the browser back to the
 * panel with a code. GitHub never calls the panel — that is what makes the
 * integration possible on a private instance.
 */
export function GitHubIntegration({
  connection,
  installations,
  installationsError,
  sourcesCount,
  instanceName,
  canManage,
  notice,
}: {
  connection: GitHubConnectionView | null;
  installations: GitHubInstallation[];
  installationsError: string | null;
  sourcesCount: number;
  instanceName: string;
  canManage: boolean;
  notice: 'installed' | 'state' | 'github' | null;
}) {
  const t = useT(messages);

  return (
    <div className="flex flex-col gap-5">
      {notice === 'installed' ? (
        <Alert variant="success">{t('integration.installed')}</Alert>
      ) : null}
      {notice === 'state' ? <Alert variant="destructive">{t('error.state')}</Alert> : null}
      {notice === 'github' ? <Alert variant="destructive">{t('integration.failed')}</Alert> : null}

      <div className="flex flex-wrap items-center gap-3">
        <span
          aria-hidden
          className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-surface-2 text-text-2"
        >
          <GitBranch className="size-4" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-2 font-semibold text-text">
            {t('integration.title')}
            <Badge variant={connection ? 'ok' : 'idle'} dot>
              {connection ? t('integration.state.on') : t('integration.state.off')}
            </Badge>
          </span>
          <span className="t-sm text-text-2">{t('integration.polling')}</span>
        </div>
      </div>

      {connection ? (
        <Connected
          connection={connection}
          installations={installations}
          installationsError={installationsError}
          sourcesCount={sourcesCount}
          canManage={canManage}
        />
      ) : canManage ? (
        <Connect instanceName={instanceName} />
      ) : null}
    </div>
  );
}

function Connected({
  connection,
  installations,
  installationsError,
  sourcesCount,
  canManage,
}: {
  connection: GitHubConnectionView;
  installations: GitHubInstallation[];
  installationsError: string | null;
  sourcesCount: number;
  canManage: boolean;
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
    const response = await fetch('/api/integrations/github', { method: 'DELETE' });
    setPending(false);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      setError(body.error?.message ?? c('http.failure', { status: response.status }));
      return;
    }
    setConfirming(false);
    toast({ title: t('integration.disconnected'), tone: 'ok' });
    router.refresh();
  }

  return (
    <>
      <KeyValue
        items={[
          {
            key: 'app',
            term: t('integration.app'),
            value: (
              <a href={connection.htmlUrl} target="_blank" rel="noreferrer" className="link">
                {connection.name}
              </a>
            ),
          },
          {
            key: 'owner',
            term: t('integration.owner'),
            value: <span className="mono">{connection.owner}</span>,
          },
          {
            key: 'id',
            term: t('integration.appId'),
            value: <span className="mono">{connection.appId ?? '—'}</span>,
          },
          {
            key: 'sources',
            term: t('integration.installations'),
            value: installationsError ? (
              <span className="text-danger-text">
                {t('integration.installations.error', { message: installationsError })}
              </span>
            ) : installations.length === 0 ? (
              <span className="text-warn-text">{t('integration.installations.none')}</span>
            ) : (
              <span className="flex flex-wrap gap-1.5">
                {installations.map((installation) => (
                  <Badge key={installation.id} variant="outline">
                    <span className="mono">{installation.account}</span>
                    <span className="text-text-3">
                      {' · '}
                      {installation.repositorySelection === 'all'
                        ? t('integration.installation.all')
                        : t('integration.installation.selected')}
                    </span>
                  </Badge>
                ))}
              </span>
            ),
          },
        ]}
      />

      <p className="t-cap text-text-3">{t('integration.sources', { count: sourcesCount })}</p>

      {canManage ? (
        <div className="flex flex-wrap items-center gap-2">
          {connection.installUrl ? (
            <Button asChild>
              <a href={connection.installUrl} target="_blank" rel="noreferrer">
                {t('integration.install')}
                <ArrowUpRight aria-hidden />
              </a>
            </Button>
          ) : null}
          <Button asChild variant="ghost">
            <a href={connection.htmlUrl} target="_blank" rel="noreferrer">
              {t('integration.manage')}
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
            {t('integration.disconnect')}
          </Button>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        level="trace"
        icon={<Unplug />}
        title={t('integration.disconnect.title')}
        consequences={[
          t('integration.disconnect.sources', { count: sourcesCount }),
          t('integration.disconnect.history'),
          t('integration.disconnect.app'),
        ]}
        confirmLabel={t('integration.disconnect')}
        pending={pending}
        error={error}
        onConfirm={disconnect}
      />
    </>
  );
}

function Connect({ instanceName }: { instanceName: string }) {
  const t = useT(messages);
  const c = useT(common);
  const router = useRouter();
  const [owner, setOwner] = useState<'personal' | 'organization'>('personal');
  const [organization, setOrganization] = useState('');
  const [name, setName] = useState(`Pupitre ${instanceName}`.slice(0, 34));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appId, setAppId] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [manualPending, setManualPending] = useState(false);

  /** Posts the manifest to GitHub from the browser: a real form submission. */
  async function create() {
    setPending(true);
    setError(null);
    const response = await fetch('/api/integrations/github/manifest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: name.trim(),
        organization: owner === 'organization' ? organization.trim() : null,
      }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      setError(body.error?.message ?? c('http.failure', { status: response.status }));
      setPending(false);
      return;
    }
    const { action, manifest } = (await response.json()) as { action: string; manifest: string };
    const form = document.createElement('form');
    form.method = 'post';
    form.action = action;
    const field = document.createElement('input');
    field.type = 'hidden';
    field.name = 'manifest';
    field.value = manifest;
    form.appendChild(field);
    document.body.appendChild(form);
    form.submit();
  }

  async function connectExisting() {
    setManualPending(true);
    setError(null);
    const response = await fetch('/api/integrations/github', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId, privateKey }),
    });
    setManualPending(false);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      setError(body.error?.message ?? c('http.failure', { status: response.status }));
      return;
    }
    setPrivateKey('');
    toast({ title: t('integration.connected'), tone: 'ok' });
    router.refresh();
  }

  const organizationMissing = owner === 'organization' && organization.trim() === '';

  return (
    <div className="flex flex-col gap-4 rounded-[10px] border border-border p-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-[14px] font-semibold text-text">{t('integration.connect.title')}</h3>
        <p className="t-sm text-text-2">{t('integration.connect.lead')}</p>
      </div>
      {error ? <Alert variant="destructive">{error}</Alert> : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={t('integration.connect.owner')}>
          <SegmentedControl
            className="w-fit"
            label={t('integration.connect.owner')}
            value={owner}
            onChange={setOwner}
            options={[
              { value: 'personal', label: t('integration.connect.owner.personal') },
              { value: 'organization', label: t('integration.connect.owner.organization') },
            ]}
          />
        </Field>
        {owner === 'organization' ? (
          <Field label={t('integration.connect.organization')}>
            <Input
              className="mono"
              value={organization}
              onChange={(event) => setOrganization(event.target.value)}
              placeholder="atelier-nord"
            />
          </Field>
        ) : null}
        <Field label={t('integration.connect.name')} help={t('integration.connect.name.help')}>
          <Input value={name} maxLength={34} onChange={(event) => setName(event.target.value)} />
        </Field>
      </div>

      <p className="t-cap text-text-3">{t('integration.connect.permissions')}</p>

      <div>
        <Button
          loading={pending}
          disabledReason={
            organizationMissing
              ? t('integration.connect.invalid.organization')
              : name.trim() === ''
                ? t('integration.connect.invalid.name')
                : null
          }
          onClick={() => void create()}
        >
          {t('integration.connect.submit')}
          <ArrowUpRight aria-hidden />
        </Button>
      </div>

      <Collapsible>
        <CollapsibleTrigger className="t-sm font-medium text-text-2 hover:text-text">
          {t('integration.manual.title')}
        </CollapsibleTrigger>
        <CollapsiblePanel className="flex flex-col gap-4 pt-3">
          <Field label={t('integration.manual.appId')}>
            <Input
              className="mono w-40"
              inputMode="numeric"
              value={appId}
              onChange={(event) => setAppId(event.target.value)}
            />
          </Field>
          <Field
            label={t('integration.manual.privateKey')}
            help={t('integration.manual.privateKey.help')}
          >
            <Textarea
              rows={6}
              spellCheck={false}
              autoComplete="off"
              className="mono"
              value={privateKey}
              placeholder="-----BEGIN RSA PRIVATE KEY-----"
              onChange={(event) => setPrivateKey(event.target.value)}
            />
          </Field>
          <div>
            <Button
              variant="secondary"
              loading={manualPending}
              disabledReason={
                appId.trim() === '' || privateKey.trim() === ''
                  ? t('integration.manual.invalid')
                  : null
              }
              onClick={() => void connectExisting()}
            >
              {t('integration.manual.submit')}
            </Button>
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}
