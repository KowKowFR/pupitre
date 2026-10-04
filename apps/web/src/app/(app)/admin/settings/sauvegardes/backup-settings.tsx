'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Archive, CircleCheck, CircleX, LoaderCircle, PlugZap, Trash2 } from 'lucide-react';
import type { BackupDestinationKind } from '@pupitre/core';
import { formatBytes } from '@/components/backups/backup-history';
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
import { CheckboxField } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Field, SecretInput } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented';
import { SwitchField } from '@/components/ui/switch';
import { useT } from '@/i18n/client';
import { backups as messages } from '@/i18n/messages/backups';
import { common } from '@/i18n/messages/common';
import type {
  ApplicationBackupsView,
  BackupScheduleView,
  BackupView,
  DestinationView,
} from '@/lib/backups';
import { formatDateTime, type FormatSettings } from '@/lib/format';
import { relativeTime } from '@/lib/relative-time';
import { toast } from '@/lib/toast';
import { ApplicationsBackups } from './applications-backups';

/**
 * Settings → Backups, screen side: the destination (one form per kind, secrets
 * never shown again), the panel's database, the applications.
 */

type ApiError = { error?: { message?: string } };

type Draft = {
  kind: BackupDestinationKind;
  name: string;
  config: Record<string, string | number | boolean>;
  secrets: Record<string, string>;
};

const DEFAULT_CONFIG: Record<BackupDestinationKind, Record<string, string | number | boolean>> = {
  s3: { endpoint: '', region: 'us-east-1', bucket: '', prefix: '', pathStyle: true },
  sftp: { host: '', port: 22, username: '', path: 'pupitre-backups', fingerprint: '' },
  local: { path: '/backups' },
};

function draftOf(destination: DestinationView | null, defaultName = ''): Draft {
  if (!destination)
    return { kind: 's3', name: defaultName, config: { ...DEFAULT_CONFIG.s3 }, secrets: {} };
  return {
    kind: destination.kind,
    name: destination.name,
    config: { ...DEFAULT_CONFIG[destination.kind], ...(destination.config as Draft['config']) },
    secrets: {},
  };
}

export function BackupSettings({
  initialDestination,
  panelBackups,
  panelSchedule,
  appsSchedule,
  enabledApps,
  appsOverview,
  canManage,
  canManageBackups,
  canRestore,
  format,
}: {
  initialDestination: DestinationView | null;
  panelBackups: BackupView[];
  panelSchedule: BackupScheduleView;
  appsSchedule: BackupScheduleView;
  enabledApps: number;
  /** The applications and their history — `null` without `backup:read`. */
  appsOverview: {
    applications: ApplicationBackupsView[];
    targetNames: Record<string, string>;
  } | null;
  canManage: boolean;
  /** `backup:manage`: delete an application's backup. */
  canManageBackups: boolean;
  /** `backup:restore`. */
  canRestore: boolean;
  format: FormatSettings;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const router = useRouter();
  const [destination, setDestination] = useState(initialDestination);
  const [draft, setDraft] = useState<Draft>(() =>
    draftOf(initialDestination, t('destination.defaultName')),
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [deleting, setDeleting] = useState<BackupView | null>(null);
  /** A test started: we read the destination again until its verdict changes. */
  const [awaitingCheck, setAwaitingCheck] = useState<string | null>(null);

  useEffect(() => {
    if (awaitingCheck === null) return;
    const started = Date.now();
    const timer = window.setInterval(async () => {
      const response = await fetch('/api/backups/destination', { cache: 'no-store' }).catch(
        () => null,
      );
      const body = response?.ok
        ? ((await response.json()) as { destination: DestinationView | null })
        : null;
      const checked = body?.destination?.lastCheckedAt ?? null;
      if ((checked && checked !== awaitingCheck) || Date.now() - started > 45_000) {
        window.clearInterval(timer);
        if (body) setDestination(body.destination);
        setAwaitingCheck(null);
        setBusy(null);
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [awaitingCheck]);

  // A panel backup in progress: the page reads itself again until it ends.
  const panelRunning = panelBackups.some((backup) => backup.status === 'running');
  useEffect(() => {
    if (!panelRunning) return;
    const timer = window.setInterval(() => router.refresh(), 4000);
    return () => window.clearInterval(timer);
  }, [panelRunning, router]);

  async function call(url: string, init: RequestInit) {
    setError(null);
    const response = await fetch(url, {
      headers: { 'content-type': 'application/json' },
      ...init,
    }).catch(() => null);
    if (!response?.ok) {
      const body = response ? ((await response.json().catch(() => ({}))) as ApiError) : {};
      setError(body.error?.message ?? tc('http.failure', { status: response?.status ?? 0 }));
      return null;
    }
    return response;
  }

  async function save() {
    setBusy('save');
    const secrets = Object.fromEntries(
      Object.entries(draft.secrets).filter(([, value]) => value.trim().length > 0),
    );
    const response = await call('/api/backups/destination', {
      method: 'PUT',
      body: JSON.stringify({ kind: draft.kind, name: draft.name, config: draft.config, secrets }),
    });
    if (!response) {
      setBusy(null);
      return;
    }
    const { destination: saved } = (await response.json()) as { destination: DestinationView };
    setDestination(saved);
    setDraft((current) => ({ ...current, secrets: {} }));
    toast({ title: t('destination.saved'), tone: 'ok' });
    // The route already queued a test: we wait for its verdict.
    setBusy('test');
    setAwaitingCheck(saved.lastCheckedAt ?? '');
    router.refresh();
  }

  async function test() {
    setBusy('test');
    const response = await call('/api/backups/destination/check', { method: 'POST' });
    if (!response) {
      setBusy(null);
      return;
    }
    setAwaitingCheck(destination?.lastCheckedAt ?? '');
  }

  const set = (key: string, value: string | number | boolean) =>
    setDraft((current) => ({ ...current, config: { ...current.config, [key]: value } }));
  const setSecret = (key: string, value: string) =>
    setDraft((current) => ({ ...current, secrets: { ...current.secrets, [key]: value } }));
  const stored = (key: string) =>
    destination?.kind === draft.kind && destination.secretFields.includes(key);
  const text = (key: string) => String(draft.config[key] ?? '');

  const field = (
    key: string,
    label: string,
    help?: string,
    props: { mono?: boolean; type?: string } = {},
  ) => (
    <Field label={label} help={help}>
      <Input
        value={text(key)}
        type={props.type ?? 'text'}
        disabled={!canManage}
        className={props.mono === false ? undefined : 'mono'}
        onChange={(event) =>
          set(key, props.type === 'number' ? Number(event.target.value) : event.target.value)
        }
      />
    </Field>
  );

  const secret = (key: string, label: string) => (
    <Field label={label}>
      <SecretInput
        stored={stored(key)}
        value={draft.secrets[key] ?? ''}
        disabled={!canManage}
        onChange={(event) => setSecret(key, event.target.value)}
      />
    </Field>
  );

  const checked = destination?.lastCheckedAt
    ? (relativeTime(destination.lastCheckedAt, tc) ??
      formatDateTime(destination.lastCheckedAt, format))
    : null;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          actions={
            destination ? (
              destination.lastCheckedAt === null ? (
                <Badge variant="idle" dot>
                  {t('destination.untested')}
                </Badge>
              ) : destination.lastCheckError ? (
                <Badge variant="danger" dot>
                  <CircleX aria-hidden className="size-3" />
                  {t('destination.badge.failed')}
                </Badge>
              ) : (
                <Badge variant="ok" dot>
                  <CircleCheck aria-hidden className="size-3" />
                  {t('destination.badge.ok')}
                </Badge>
              )
            ) : null
          }
        >
          <CardTitle>{t('destination.title')}</CardTitle>
          <CardDescription>{t('destination.description')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {error ? <Alert variant="destructive">{error}</Alert> : null}
          {destination ? (
            <p className="t-sm flex flex-wrap items-center gap-2">
              <span className="mono text-text">{destination.description}</span>
              {/* "tested 3 min ago": the server's clock and the browser's differ. */}
              <span
                className={destination.lastCheckError ? 'text-danger-text' : 'text-text-3'}
                suppressHydrationWarning
              >
                {destination.lastCheckedAt === null
                  ? t('destination.untested')
                  : destination.lastCheckError
                    ? t('destination.failed', {
                        ago: checked ?? '',
                        error: destination.lastCheckError,
                      })
                    : t('destination.ok', { ago: checked ?? '' })}
              </span>
            </p>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <span className="t-sm font-medium">{t('destination.kind')}</span>
            <SegmentedControl
              label={t('destination.kind')}
              value={draft.kind}
              options={(['s3', 'sftp', 'local'] as const).map((kind) => ({
                value: kind,
                label: t(`destination.kind.${kind}`),
              }))}
              onChange={(kind) =>
                canManage &&
                setDraft((current) => ({
                  ...current,
                  kind,
                  config:
                    destination?.kind === kind
                      ? draftOf(destination).config
                      : { ...DEFAULT_CONFIG[kind] },
                  secrets: {},
                }))
              }
            />
            <span className="help">{t(`destination.kind.${draft.kind}.help`)}</span>
          </div>

          {draft.kind === 's3' ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {field('endpoint', t('field.endpoint'), t('field.endpoint.help'))}
              {field('bucket', t('field.bucket'))}
              {field('region', t('field.region'))}
              {field('prefix', t('field.prefix'), t('field.prefix.help'))}
              {secret('accessKeyId', t('field.accessKeyId'))}
              {secret('secretAccessKey', t('field.secretAccessKey'))}
              <CheckboxField
                className="sm:col-span-2"
                label={t('field.pathStyle')}
                help={t('field.pathStyle.help')}
                checked={draft.config.pathStyle === true}
                disabled={!canManage}
                onChange={(event) => set('pathStyle', event.target.checked)}
              />
            </div>
          ) : draft.kind === 'sftp' ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {field('host', t('field.host'))}
              {field('port', t('field.port'), undefined, { type: 'number' })}
              {field('username', t('field.username'))}
              {field('path', t('field.path'), t('field.path.help'))}
              {secret('password', t('field.password'))}
              <Field label={t('field.privateKey')} help={t('field.authHelp')}>
                <Textarea
                  rows={3}
                  spellCheck={false}
                  value={draft.secrets.privateKey ?? ''}
                  disabled={!canManage}
                  placeholder={
                    stored('privateKey') ? '••••••••' : '-----BEGIN OPENSSH PRIVATE KEY-----'
                  }
                  className="mono text-[11.5px]"
                  onChange={(event) => setSecret('privateKey', event.target.value)}
                />
              </Field>
              <div className="sm:col-span-2">
                {field('fingerprint', t('field.fingerprint'), t('field.fingerprint.help'))}
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3">
              {field('path', t('field.localPath'), t('field.localPath.help'))}
            </div>
          )}
        </CardContent>
        {canManage ? (
          <CardFooter className="flex flex-wrap items-center gap-2">
            <Button loading={busy === 'save'} disabled={busy !== null} onClick={() => void save()}>
              {t('destination.save')}
            </Button>
            {destination ? (
              <Button
                variant="secondary"
                loading={busy === 'test'}
                disabled={busy !== null}
                onClick={() => void test()}
              >
                {busy === 'test' ? null : <PlugZap aria-hidden />}
                {busy === 'test' ? t('destination.testing') : t('destination.test')}
              </Button>
            ) : null}
            {destination ? (
              <Button
                variant="ghost"
                className="ml-auto text-danger-text"
                disabled={busy !== null}
                onClick={() => setRemoving(true)}
              >
                {t('destination.remove')}
              </Button>
            ) : null}
          </CardFooter>
        ) : null}
      </Card>

      <Card>
        <CardHeader
          actions={
            canManage && destination ? (
              <Button
                variant="secondary"
                size="sm"
                loading={busy === 'panel'}
                disabled={panelRunning || busy !== null}
                onClick={async () => {
                  setBusy('panel');
                  const response = await call('/api/backups/panel', { method: 'POST' });
                  setBusy(null);
                  if (response) {
                    toast({ title: t('panel.queued'), tone: 'ok' });
                    router.refresh();
                  }
                }}
              >
                {busy === 'panel' ? null : <Archive aria-hidden />}
                {t('panel.now')}
              </Button>
            ) : null
          }
        >
          <CardTitle>{t('panel.title')}</CardTitle>
          <CardDescription>{t('panel.description')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <SwitchField
            label={t('panel.auto')}
            help={
              panelSchedule?.enabled && panelSchedule.nextRunAt
                ? `${t('panel.auto.help')} ${t('panel.next', { next: formatDateTime(panelSchedule.nextRunAt, format) })}`
                : t('panel.auto.help')
            }
            checked={panelSchedule?.enabled === true}
            disabled={!canManage || busy !== null}
            onChange={async (event) => {
              setBusy('schedule');
              const response = await call('/api/backups/panel/schedule', {
                method: 'PUT',
                body: JSON.stringify({ enabled: event.target.checked }),
              });
              setBusy(null);
              if (response) router.refresh();
            }}
          />

          <Alert variant="warn" title={t('panel.masterKey.title')}>
            {t('panel.masterKey.body')}
          </Alert>

          {panelBackups.length === 0 ? (
            <p className="t-sm text-text-3">{t('panel.empty')}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border">
              {panelBackups.map((backup) => (
                <li
                  key={backup.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
                >
                  <span className="mono t-sm">{formatDateTime(backup.startedAt, format)}</span>
                  <Badge
                    variant={
                      backup.status === 'success'
                        ? 'ok'
                        : backup.status === 'failed'
                          ? 'danger'
                          : 'accent'
                    }
                    dot
                  >
                    {backup.status === 'running' ? (
                      <LoaderCircle aria-hidden className="size-3 animate-spin" />
                    ) : null}
                    {t(`status.${backup.status}`)}
                  </Badge>
                  <span className="t-cap text-text-3">
                    {t(`trigger.${backup.trigger}`)}
                    {backup.status === 'success' ? ` · ${formatBytes(backup.bytes)}` : ''}
                  </span>
                  <span className="mono t-cap min-w-0 flex-1 truncate text-text-3">
                    {backup.status === 'failed' ? (
                      <span className="text-danger-text">{backup.error}</span>
                    ) : (
                      backup.location
                    )}
                  </span>
                  {canManage && backup.status !== 'running' ? (
                    <Button variant="ghost" size="sm" onClick={() => setDeleting(backup)}>
                      <Trash2 aria-hidden />
                      {t('action.delete')}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-col gap-1.5">
            <span className="t-sm font-medium">{t('panel.restore.title')}</span>
            <span className="t-sm text-text-2">{t('panel.restore.body')}</span>
            <pre className="mono overflow-x-auto rounded-lg border border-border bg-surface-2 px-3 py-2 text-[12px] leading-5 text-text">
              {[
                'docker compose stop web worker',
                'docker compose run --rm worker backup list',
                'docker compose run --rm worker backup restore-panel panel/<dossier> --yes',
                'docker compose start web worker',
              ].join('\n')}
            </pre>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader
          actions={
            appsSchedule ? (
              <Button variant="secondary" size="sm" asChild>
                <Link href="/jobs">{t('jobs.link')}</Link>
              </Button>
            ) : null
          }
        >
          <CardTitle>{t('apps.title')}</CardTitle>
          <CardDescription>
            {enabledApps > 0 ? t('apps.count', { count: enabledApps }) : t('apps.none')}{' '}
            {appsSchedule
              ? appsSchedule.enabled && appsSchedule.nextRunAt
                ? t('apps.schedule', { next: formatDateTime(appsSchedule.nextRunAt, format) })
                : t('schedule.paused')
              : t('apps.noSchedule')}
          </CardDescription>
        </CardHeader>
        {appsOverview ? (
          <CardContent>
            <ApplicationsBackups
              applications={appsOverview.applications}
              targetNames={appsOverview.targetNames}
              canRestore={canRestore}
              canManage={canManageBackups}
              format={format}
            />
          </CardContent>
        ) : null}
      </Card>

      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        level="reversible"
        title={t('destination.remove.title')}
        consequences={[t('destination.remove.consequence')]}
        confirmLabel={t('destination.remove')}
        onConfirm={async () => {
          setRemoving(false);
          const response = await call('/api/backups/destination', { method: 'DELETE' });
          if (response) {
            setDestination(null);
            setDraft(draftOf(null, t('destination.defaultName')));
            toast({ title: t('destination.removed'), tone: 'ok' });
            router.refresh();
          }
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => (open ? undefined : setDeleting(null))}
        level="reversible"
        title={
          deleting ? t('delete.title', { date: formatDateTime(deleting.startedAt, format) }) : ''
        }
        consequences={[t('delete.consequence')]}
        confirmLabel={t('action.delete')}
        onConfirm={async () => {
          if (!deleting) return;
          const backup = deleting;
          setDeleting(null);
          const response = await call(`/api/backups/${backup.id}`, { method: 'DELETE' });
          if (response) {
            toast({ title: t('delete.queued'), tone: 'ok' });
            window.setTimeout(() => router.refresh(), 1500);
          }
        }}
      />
    </div>
  );
}
