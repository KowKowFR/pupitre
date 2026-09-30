'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  notificationSeverityLabel,
  type NotificationChannelKind,
  type NotificationEventKey,
  type PresentedNotificationChannel,
  type PresentedNotificationEvent,
  type PresentedNotificationField,
} from '@pupitre/core';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { useLanguage, useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { notifications as messages } from '@/i18n/messages/notifications';

/**
 * Écran des canaux de notification.
 *
 * Le formulaire est **engendré par le catalogue** : ce fichier ne mentionne ni
 * « smtp », ni « botToken », ni « webhookUrl ». Il connaît quatre façons de
 * saisir une valeur — texte, mot de passe, nombre, booléen, liste — et c'est
 * tout. Ajouter un cinquième canal ne demande donc rien ici.
 *
 * Les secrets ne descendent jamais jusqu'au navigateur : le serveur envoie la
 * liste des champs **renseignés**, pas leurs valeurs. Un champ secret déjà posé
 * s'affiche vide avec la mention « enregistré » ; le laisser vide le conserve.
 */

type ChannelView = {
  id: string;
  kind: NotificationChannelKind;
  name: string;
  enabled: boolean;
  config: Record<string, string | number | boolean>;
  events: NotificationEventKey[];
  configuredSecrets: string[];
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
};

type Draft = {
  id: string | null;
  kind: NotificationChannelKind;
  name: string;
  enabled: boolean;
  values: Record<string, string>;
  booleans: Record<string, boolean>;
  events: NotificationEventKey[];
  clearedSecrets: string[];
};

type ApiError = { error?: { message?: string } };

type TestVerdict = {
  name: string;
  probe: { ok: boolean; detail: string };
  delivered: boolean;
  error: string | null;
};

function emptyDraft(catalog: PresentedNotificationChannel[]): Draft {
  const first = catalog[0];
  return draftFor(first, null);
}

function draftFor(descriptor: PresentedNotificationChannel | undefined, channel: ChannelView | null): Draft {
  const values: Record<string, string> = {};
  const booleans: Record<string, boolean> = {};

  for (const field of descriptor?.fields ?? []) {
    const current = channel?.config[field.name];
    if (field.kind === 'boolean') {
      booleans[field.name] =
        typeof current === 'boolean' ? current : field.defaultValue === true;
      continue;
    }
    // Un secret n'arrive jamais du serveur : le champ reste vide, et vide
    // signifie « inchangé ».
    values[field.name] = field.secret
      ? ''
      : current === undefined || current === null
        ? field.defaultValue === null
          ? ''
          : String(field.defaultValue)
        : String(current);
  }

  return {
    id: channel?.id ?? null,
    kind: descriptor?.kind ?? 'webhook',
    name: channel?.name ?? '',
    enabled: channel?.enabled ?? true,
    values,
    booleans,
    events: channel?.events ?? [],
    clearedSecrets: [],
  };
}

export function NotificationsManager({
  initialChannels,
  catalog,
  events,
  canManage,
}: {
  initialChannels: ChannelView[];
  catalog: PresentedNotificationChannel[];
  events: PresentedNotificationEvent[];
  canManage: boolean;
}) {
  const router = useRouter();
  const t = useT(messages);
  const tc = useT(common);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<TestVerdict | null>(null);

  const descriptorOf = (kind: NotificationChannelKind) =>
    catalog.find((entry) => entry.kind === kind);
  const eventLabel = (key: string) => events.find((entry) => entry.key === key)?.label ?? key;

  async function call(url: string, init: RequestInit): Promise<unknown | null> {
    setPending(true);
    setError(null);
    setNotice(null);
    const response = await fetch(url, {
      ...init,
      headers: { 'content-type': 'application/json', ...init.headers },
    });
    setPending(false);
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as ApiError;
      setError(payload.error?.message ?? tc('http.failure', { status: response.status }));
      return null;
    }
    return response.json();
  }

  function submit(): void {
    if (!draft) return;
    const descriptor = descriptorOf(draft.kind);
    if (!descriptor) return;

    const config: Record<string, string | number | boolean> = {};
    const secrets: Record<string, string | null> = {};

    for (const field of descriptor.fields) {
      if (field.secret) {
        const typed = draft.values[field.name]?.trim() ?? '';
        if (typed.length > 0) secrets[field.name] = typed;
        else if (draft.clearedSecrets.includes(field.name)) secrets[field.name] = null;
        continue;
      }
      if (field.kind === 'boolean') {
        config[field.name] = draft.booleans[field.name] ?? false;
        continue;
      }
      const raw = draft.values[field.name]?.trim() ?? '';
      // Un champ facultatif laissé vide n'est pas envoyé : le schéma le rendrait
      // invalide alors qu'il est simplement absent.
      if (raw.length === 0 && !field.required) continue;
      config[field.name] = field.kind === 'number' ? Number(raw) : raw;
    }

    const body = {
      name: draft.name.trim(),
      enabled: draft.enabled,
      config,
      secrets,
      events: draft.events,
      ...(draft.id === null ? { kind: draft.kind } : {}),
    };

    void (async () => {
      const result = await call(
        draft.id === null
          ? '/api/notifications/channels'
          : `/api/notifications/channels/${draft.id}`,
        { method: draft.id === null ? 'POST' : 'PATCH', body: JSON.stringify(body) },
      );
      if (!result) return;
      setDraft(null);
      setNotice(draft.id === null ? t('channel.created') : t('channel.saved'));
      router.refresh();
    })();
  }

  function remove(channel: ChannelView): void {
    void (async () => {
      const result = await call(`/api/notifications/channels/${channel.id}`, { method: 'DELETE' });
      if (!result) return;
      setNotice(t('channel.deleted', { name: channel.name }));
      router.refresh();
    })();
  }

  function test(channel: ChannelView): void {
    setVerdict(null);
    void (async () => {
      const result = await call(`/api/notifications/channels/${channel.id}/test`, {
        method: 'POST',
      });
      if (!result) return;
      setVerdict(result as TestVerdict);
      router.refresh();
    })();
  }

  return (
    <div className="flex flex-col gap-5">
      {error ? <Alert variant="destructive">{error}</Alert> : null}
      {notice ? <Alert variant="success">{notice}</Alert> : null}
      {verdict ? (
        <Alert variant={verdict.delivered ? 'success' : 'destructive'}>
          <strong>{verdict.name}</strong> — {verdict.probe.ok ? t('test.probe') : t('test.probeFailed')}
          {verdict.probe.detail}
          <br />
          {verdict.delivered
            ? t('test.delivered')
            : t('test.failed', { detail: verdict.error ?? t('test.noDetail') })}
        </Alert>
      ) : null}

      {initialChannels.length === 0 ? (
        <Alert>{t('empty')}</Alert>
      ) : (
        <ul className="flex flex-col gap-3">
          {initialChannels.map((channel) => {
            const descriptor = descriptorOf(channel.kind);
            return (
              <li key={channel.id} className="rounded-md border border-border p-3.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-text">{channel.name}</span>
                  <Badge variant="secondary">{descriptor?.label ?? channel.kind}</Badge>
                  <Badge variant={channel.enabled ? 'ok' : 'outline'}>
                    {channel.enabled ? t('channel.on') : t('channel.off')}
                  </Badge>
                  {channel.consecutiveFailures > 0 ? (
                    <Badge variant="destructive">
                      {t('channel.failures', { count: channel.consecutiveFailures })}
                    </Badge>
                  ) : null}
                </div>

                <p className="mt-1.5 text-xs text-text-3">
                  {channel.events.length === 0
                    ? t('channel.noEvents')
                    : t('channel.events', { list: channel.events.map(eventLabel).join(', ') })}
                </p>

                {channel.configuredSecrets.length > 0 ? (
                  <p className="mt-1 text-xs text-text-3">
                    {t('channel.secrets', { list: channel.configuredSecrets.join(', ') })}
                  </p>
                ) : null}

                {channel.lastError ? (
                  <p className="mt-1.5 font-mono text-xs text-danger-text">
                    {t('channel.lastError', {
                      at: channel.lastFailureAt ?? '?',
                      error: channel.lastError,
                    })}
                  </p>
                ) : channel.lastSuccessAt ? (
                  <p className="mt-1.5 text-xs text-text-3">
                    {t('channel.lastSuccess', { at: channel.lastSuccessAt })}
                  </p>
                ) : null}

                {canManage ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      type="button"
                      disabled={pending}
                      onClick={() => setDraft(draftFor(descriptor, channel))}
                    >
                      {tc('edit')}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      type="button"
                      disabled={pending}
                      onClick={() => test(channel)}
                    >
                      {pending ? t('test.sending') : t('test.send')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      type="button"
                      disabled={pending}
                      onClick={() => remove(channel)}
                    >
                      {tc('delete')}
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {canManage && draft === null ? (
        <div>
          <Button size="sm" type="button" onClick={() => setDraft(emptyDraft(catalog))}>
            {t('channel.add')}
          </Button>
        </div>
      ) : null}

      {canManage && draft !== null ? (
        <ChannelForm
          draft={draft}
          catalog={catalog}
          events={events}
          pending={pending}
          onChange={setDraft}
          onCancel={() => setDraft(null)}
          onSubmit={submit}
        />
      ) : null}
    </div>
  );
}

function ChannelForm({
  draft,
  catalog,
  events,
  pending,
  onChange,
  onCancel,
  onSubmit,
}: {
  draft: Draft;
  catalog: PresentedNotificationChannel[];
  events: PresentedNotificationEvent[];
  pending: boolean;
  onChange: (draft: Draft) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const language = useLanguage();
  const descriptor = catalog.find((entry) => entry.kind === draft.kind);

  return (
    <form
      className="flex flex-col gap-4 rounded-md border border-border-strong bg-surface-2/40 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="channel-kind">{t('form.kind')}</Label>
          <Select
            id="channel-kind"
            value={draft.kind}
            // Le type ne se change pas après coup : les champs n'ont rien à voir
            // d'un canal à l'autre, et « convertir » un SMTP en Discord n'a pas
            // de sens. On supprime, on recrée.
            disabled={draft.id !== null}
            onChange={(event) => {
              const kind = event.target.value as NotificationChannelKind;
              const next = draftFor(
                catalog.find((entry) => entry.kind === kind),
                null,
              );
              onChange({ ...next, name: draft.name, events: draft.events });
            }}
          >
            {catalog.map((entry) => (
              <option key={entry.kind} value={entry.kind}>
                {entry.label}
              </option>
            ))}
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="channel-name">{t('form.name')}</Label>
          <Input
            id="channel-name"
            value={draft.name}
            placeholder={t('form.name.placeholder')}
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
          />
        </div>
      </div>

      {descriptor ? (
        <p className="text-xs text-text-3">
          {descriptor.description} <span className="text-text-2">{descriptor.prerequisite}</span>
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        {(descriptor?.fields ?? []).map((field) => (
          <FieldInput
            key={field.name}
            field={field}
            draft={draft}
            onChange={onChange}
          />
        ))}
      </div>

      <fieldset className="space-y-2">
        <legend className="eyebrow text-text-2">{t('form.events.legend')}</legend>
        <p className="text-xs text-text-3">{t('form.events.help')}</p>
        <div className="flex flex-col gap-1.5 pt-1">
          {events.map((entry) => {
            const checked = draft.events.includes(entry.key as NotificationEventKey);
            return (
              <label key={entry.key} className="flex items-start gap-2.5 text-sm">
                <Checkbox
                  className="mt-0.5"
                  checked={checked}
                  onChange={(changed) =>
                    onChange({
                      ...draft,
                      events: changed.target.checked
                        ? [...draft.events, entry.key as NotificationEventKey]
                        : draft.events.filter((key) => key !== entry.key),
                    })
                  }
                />
                <span className="min-w-0">
                  <span className="block text-text">
                    {entry.label}{' '}
                    <span className="text-xs text-text-3">
                      ({notificationSeverityLabel(entry.severity, language).toLowerCase()})
                    </span>
                  </span>
                  <span className="block text-xs text-text-3">{entry.rationale}</span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <label className="flex items-center gap-2.5 text-sm">
        <Checkbox
          checked={draft.enabled}
          onChange={(event) => onChange({ ...draft, enabled: event.target.checked })}
        />
        <span className="text-text">{t('form.enabled')}</span>
      </label>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" type="submit" disabled={pending}>
          {pending ? tc('saving') : draft.id === null ? t('form.create') : tc('save')}
        </Button>
        <Button size="sm" type="button" variant="ghost" disabled={pending} onClick={onCancel}>
          {tc('cancel')}
        </Button>
      </div>
    </form>
  );
}

/** Un champ du catalogue, rendu selon son *type de saisie* — jamais selon son canal. */
function FieldInput({
  field,
  draft,
  onChange,
}: {
  field: PresentedNotificationField;
  draft: Draft;
  onChange: (draft: Draft) => void;
}) {
  const t = useT(messages);
  const id = `field-${field.name}`;

  if (field.kind === 'boolean') {
    return (
      <label className="flex items-start gap-2.5 self-end rounded-md border border-border px-3 py-2 text-sm">
        <Checkbox
          className="mt-0.5"
          checked={draft.booleans[field.name] ?? false}
          onChange={(event) =>
            onChange({
              ...draft,
              booleans: { ...draft.booleans, [field.name]: event.target.checked },
            })
          }
        />
        <span className="min-w-0">
          <span className="block text-text">{field.label}</span>
          {field.help ? <span className="block text-xs text-text-3">{field.help}</span> : null}
        </span>
      </label>
    );
  }

  const value = draft.values[field.name] ?? '';
  const update = (next: string) =>
    onChange({ ...draft, values: { ...draft.values, [field.name]: next } });

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {field.label}
        {field.required ? null : <span className="text-text-3">{t('field.optional')}</span>}
      </Label>

      {field.kind === 'select' ? (
        <Select id={id} value={value} onChange={(event) => update(event.target.value)}>
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      ) : (
        <Input
          id={id}
          type={field.kind === 'password' ? 'password' : field.kind === 'number' ? 'number' : 'text'}
          value={value}
          placeholder={field.placeholder ?? undefined}
          autoComplete={field.secret ? 'new-password' : 'off'}
          onChange={(event) => update(event.target.value)}
        />
      )}

      {field.help ? <p className="text-xs text-text-3">{field.help}</p> : null}

      {field.secret && draft.id !== null ? (
        <p className="text-xs text-text-3">
          {t('field.secret.keep')}
          {field.required ? null : (
            <>
              {' '}
              <button
                type="button"
                className="text-accent underline-offset-4 hover:underline"
                onClick={() =>
                  onChange({
                    ...draft,
                    values: { ...draft.values, [field.name]: '' },
                    clearedSecrets: [...new Set([...draft.clearedSecrets, field.name])],
                  })
                }
              >
                {t('field.secret.clear')}
              </button>
              {draft.clearedSecrets.includes(field.name) ? ` ${t('field.secret.cleared')}` : null}
            </>
          )}
        </p>
      ) : null}
    </div>
  );
}
