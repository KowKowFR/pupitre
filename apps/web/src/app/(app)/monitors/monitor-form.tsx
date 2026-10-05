'use client';

import * as React from 'react';
import { Radar } from 'lucide-react';
import { formatCadence, type MonitorType } from '@pupitre/core';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FieldValue } from '@/components/ui/data';
import { DrawerBody, DrawerFooter, DrawerHeader } from '@/components/ui/drawer';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useLanguage, useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { monitors as messages } from '@/i18n/messages/monitors';
import { cleanConfig, ConfigFields, defaultsOf, type ConfigValues } from './config-fields';

export type TypeOption = {
  type: MonitorType;
  label: string;
  description: string;
  neverDoes: string;
  fields: Parameters<typeof ConfigFields>[0]['fields'];
  minIntervalSeconds: number;
  defaultIntervalSeconds: number;
  defaults: unknown;
  uptimeMeans: string;
};

export type AdoptableApp = {
  applicationId: string;
  slug: string;
  name: string;
  url: string;
};

/** An existing probe, as the edit form takes it. */
export type EditableMonitor = {
  id: string;
  name: string;
  type: MonitorType;
  config: ConfigValues;
  intervalSeconds: number;
  failureThreshold: number;
  recoveryThreshold: number;
  /** The URL is encrypted in the database and never comes back to the browser: we only know it
   *  exists. */
  hasWebhook: boolean;
};

type ApiError = { error?: { message?: string } };

/** The offered cadences. Filtered by the minimum the type declares. */
const INTERVAL_CHOICES = [30, 60, 300, 900, 3_600, 6 * 3_600, 12 * 3_600, 86_400];

/**
 * A probe's form, for creation as for editing.
 *
 * A single form for both, because both say the same thing: what is probed, at
 * what cadence, and when an outage becomes an incident. Only two differences:
 *
 *  - **the type cannot be changed.** Changing a probe's type is creating another
 *    one: its history and its incidents would be about something else. The
 *    server refuses it; the form shows it read-only;
 *  - **the webhook is not read back.** Its URL is encrypted in the database and
 *    often carries a secret: it does not come back to the browser. It can be
 *    replaced or removed; left empty, the field keeps it.
 */
export function MonitorForm(
  props: {
    types: TypeOption[];
    onDone: (name: string) => void;
    /** Going back without saving — the record, when editing from it. */
    onCancel?: () => void;
  } & ({ mode: 'create'; app: AdoptableApp | null } | { mode: 'edit'; monitor: EditableMonitor }),
) {
  const { types, onDone, onCancel } = props;
  const t = useT(messages);
  const tc = useT(common);
  const language = useLanguage();
  const editing = props.mode === 'edit' ? props.monitor : null;
  const app = props.mode === 'create' ? props.app : null;

  const http = types.find((entry) => entry.type === 'http');
  const first = editing
    ? types.find((entry) => entry.type === editing.type)
    : app && http
      ? http
      : types[0];
  const [type, setType] = React.useState<MonitorType>(editing?.type ?? first?.type ?? 'http');
  const [name, setName] = React.useState(editing?.name ?? app?.name ?? '');
  const [config, setConfig] = React.useState<ConfigValues>(() =>
    editing
      ? { ...editing.config }
      : app
        ? { ...defaultsOf(http?.defaults), url: app.url }
        : defaultsOf(first?.defaults),
  );
  const [intervalSeconds, setIntervalSeconds] = React.useState(
    editing?.intervalSeconds ?? first?.defaultIntervalSeconds ?? 60,
  );
  const [failureThreshold, setFailureThreshold] = React.useState(editing?.failureThreshold ?? 3);
  const [recoveryThreshold, setRecoveryThreshold] = React.useState(editing?.recoveryThreshold ?? 2);
  const [webhookUrl, setWebhookUrl] = React.useState('');
  const [removeWebhook, setRemoveWebhook] = React.useState(false);
  const [applicationId, setApplicationId] = React.useState<string | null>(
    app?.applicationId ?? null,
  );
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const definition = types.find((option) => option.type === type) ?? first;

  function pickType(next: MonitorType): void {
    const option = types.find((entry) => entry.type === next);
    setType(next);
    setConfig(defaultsOf(option?.defaults));
    setIntervalSeconds(option?.defaultIntervalSeconds ?? 60);
    setApplicationId(null);
  }

  /**
   * When editing, only what the operator changed goes to the server.
   *
   * It is not a saving: sending the configuration back makes it validate again,
   * DNS resolution included (SSRF guard). Changing a threshold must not fail
   * because the host's name does not resolve at that instant — and the log must
   * only show what really moved.
   */
  function editPatch(monitor: EditableMonitor): Record<string, unknown> {
    const patch: Record<string, unknown> = {};
    if (name !== monitor.name) patch.name = name;
    const next = cleanConfig(config);
    if (JSON.stringify(next) !== JSON.stringify(cleanConfig(monitor.config))) patch.config = next;
    if (intervalSeconds !== monitor.intervalSeconds) patch.intervalSeconds = intervalSeconds;
    if (failureThreshold !== monitor.failureThreshold) patch.failureThreshold = failureThreshold;
    if (recoveryThreshold !== monitor.recoveryThreshold) {
      patch.recoveryThreshold = recoveryThreshold;
    }
    // The webhook: a typed URL replaces it, "Remove" clears it, nothing keeps it.
    const typed = webhookUrl.trim();
    if (typed !== '') patch.webhookUrl = typed;
    else if (removeWebhook) patch.webhookUrl = null;
    return patch;
  }

  const unchanged = editing !== null && Object.keys(editPatch(editing)).length === 0;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    const response = editing
      ? await fetch(`/api/monitors/${editing.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(editPatch(editing)),
        })
      : await fetch('/api/monitors', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name,
            config: cleanConfig(config),
            intervalSeconds,
            failureThreshold,
            recoveryThreshold,
            type,
            applicationId,
            webhookUrl: webhookUrl.trim() === '' ? null : webhookUrl.trim(),
          }),
        });

    setSubmitting(false);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      setError(body.error?.message ?? tc('http.failure', { status: response.status }));
      return;
    }
    onDone(name);
  }

  // A cadence set outside the offered choices (through the API) stays selectable:
  // opening the form must not change it on the sly.
  const intervals = [
    ...new Set([
      ...INTERVAL_CHOICES.filter((seconds) => seconds >= (definition?.minIntervalSeconds ?? 30)),
      intervalSeconds,
    ]),
  ].sort((a, b) => a - b);

  return (
    <form className="contents" onSubmit={(event) => void submit(event)}>
      <DrawerHeader
        icon={<Radar />}
        kind={t('drawer.kind')}
        title={editing ? t('edit.title', { name: editing.name }) : t('create.title')}
        extra={
          definition ? (
            <p className="t-sm text-text-2">
              {definition.description} {definition.neverDoes}
            </p>
          ) : null
        }
      />
      <DrawerBody>
        {error ? <Alert variant="destructive">{error}</Alert> : null}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t('create.name.label')}>
            <Input
              value={name}
              required
              maxLength={120}
              placeholder={t('create.name.placeholder')}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          {editing ? (
            <div className="field">
              <FieldValue label={t('create.type.label')}>{definition?.label ?? type}</FieldValue>
              <p className="help">{t('edit.type.fixed')}</p>
            </div>
          ) : (
            <Field label={t('create.type.label')}>
              <Select
                value={type}
                onChange={(event) => pickType(event.target.value as MonitorType)}
              >
                {types.map((option) => (
                  <option key={option.type} value={option.type}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>

        {definition ? (
          <ConfigFields
            fields={definition.fields}
            values={config}
            idPrefix="monitor-config"
            onChange={(key, value) => setConfig((previous) => ({ ...previous, [key]: value }))}
          />
        ) : null}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field
            label={t('create.interval.label')}
            help={
              definition
                ? t('create.interval.floor', {
                    cadence: formatCadence(definition.minIntervalSeconds, language),
                  })
                : undefined
            }
          >
            <Select
              value={String(intervalSeconds)}
              onChange={(event) => setIntervalSeconds(Number(event.target.value))}
            >
              {intervals.map((seconds) => (
                <option key={seconds} value={seconds}>
                  {formatCadence(seconds, language)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('create.failure.label')} help={t('create.failure.hint')}>
            <Input
              type="number"
              min={1}
              max={10}
              className="mono"
              value={failureThreshold}
              onChange={(event) => setFailureThreshold(Number(event.target.value))}
            />
          </Field>
          <Field label={t('create.recovery.label')} help={t('create.recovery.hint')}>
            <Input
              type="number"
              min={1}
              max={10}
              className="mono"
              value={recoveryThreshold}
              onChange={(event) => setRecoveryThreshold(Number(event.target.value))}
            />
          </Field>
        </div>

        <Field
          label={t('create.webhook.label')}
          optional
          help={
            <>
              {editing?.hasWebhook ? (
                <span className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className={removeWebhook ? 'text-warn-text' : undefined}>
                    {removeWebhook ? t('edit.webhook.removing') : t('edit.webhook.kept')}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setRemoveWebhook((current) => !current);
                      setWebhookUrl('');
                    }}
                  >
                    {removeWebhook ? t('edit.webhook.keep') : t('edit.webhook.remove')}
                  </Button>
                </span>
              ) : null}
              {t('create.webhook.payload.a')}
              <strong>{t('create.webhook.payload.and')}</strong>
              {t('create.webhook.payload.b')}
              <code className="mono">text</code>
              {t('create.webhook.payload.c')} <code className="mono">content</code>
              {t('create.webhook.payload.d')}{' '}
              {/*
                Two outputs exist for the same outage. Saying so here, when the URL
                is typed in, is the only place where the information arrives in
                time: otherwise the operator discovers the duplicate by receiving it.
                             */}
              {t('create.webhook.scope.a')}
              <strong>{t('create.webhook.scope.only')}</strong>
              {t('create.webhook.scope.b')}
              <strong>{t('create.webhook.scope.all')}</strong>
              {t('create.webhook.scope.c')}
            </>
          }
        >
          <Input
            type="url"
            className="mono"
            value={webhookUrl}
            disabled={removeWebhook}
            placeholder={
              editing?.hasWebhook ? t('edit.webhook.placeholder') : t('create.webhook.placeholder')
            }
            onChange={(event) => setWebhookUrl(event.target.value)}
          />
        </Field>
      </DrawerBody>
      <DrawerFooter end={null}>
        <Button
          type="submit"
          loading={submitting}
          disabledReason={unchanged ? t('edit.unchanged') : null}
        >
          {editing
            ? submitting
              ? tc('saving')
              : t('edit.submit')
            : submitting
              ? tc('creating')
              : t('create.submit')}
        </Button>
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            {tc('cancel')}
          </Button>
        ) : null}
      </DrawerFooter>
    </form>
  );
}
