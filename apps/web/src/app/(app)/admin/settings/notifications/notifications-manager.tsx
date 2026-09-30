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
import { Bell, Plus, Send, Trash2 } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Drawer, DrawerBody, DrawerFooter, DrawerHeader } from '@/components/ui/drawer';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { IconButton } from '@/components/ui/tooltip';
import { useLanguage, useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { notifications as messages } from '@/i18n/messages/notifications';
import { formatDateTime, type FormatSettings } from '@/lib/format';
import { toast } from '@/lib/toast';

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

function draftFor(
  descriptor: PresentedNotificationChannel | undefined,
  channel: ChannelView | null,
): Draft {
  const values: Record<string, string> = {};
  const booleans: Record<string, boolean> = {};

  for (const field of descriptor?.fields ?? []) {
    const current = channel?.config[field.name];
    if (field.kind === 'boolean') {
      booleans[field.name] = typeof current === 'boolean' ? current : field.defaultValue === true;
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
  title,
  description,
  initialChannels,
  catalog,
  events,
  canManage,
  format,
}: {
  title: string;
  description: string;
  initialChannels: ChannelView[];
  catalog: PresentedNotificationChannel[];
  events: PresentedNotificationEvent[];
  canManage: boolean;
  format: FormatSettings;
}) {
  const router = useRouter();
  const t = useT(messages);
  const tc = useT(common);
  const [draft, setDraft] = useState<Draft | null>(null);
  /** Clé d'ouverture du drawer : un brouillon neuf à chaque ouverture. */
  const [drawerKey, setDrawerKey] = useState(0);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ChannelView | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const descriptorOf = (kind: NotificationChannelKind) =>
    catalog.find((entry) => entry.kind === kind);
  const eventLabel = (key: string) => events.find((entry) => entry.key === key)?.label ?? key;
  const editing = draft?.id
    ? (initialChannels.find((entry) => entry.id === draft.id) ?? null)
    : null;

  /** Un appel d'API ; le refus s'affiche là où l'on regarde (`report`). */
  async function call(
    key: string,
    url: string,
    init: RequestInit,
    report: (message: string) => void,
  ): Promise<unknown | null> {
    setPending(key);
    const response = await fetch(url, {
      ...init,
      headers: { 'content-type': 'application/json', ...init.headers },
    });
    setPending(null);
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as ApiError;
      report(payload.error?.message ?? tc('http.failure', { status: response.status }));
      return null;
    }
    return response.json();
  }

  function open(next: Draft) {
    setFormError(null);
    setDrawerKey((key) => key + 1);
    setDraft(next);
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
      setFormError(null);
      const result = await call(
        'form',
        draft.id === null
          ? '/api/notifications/channels'
          : `/api/notifications/channels/${draft.id}`,
        { method: draft.id === null ? 'POST' : 'PATCH', body: JSON.stringify(body) },
        setFormError,
      );
      if (!result) return;
      setDraft(null);
      toast({ title: draft.id === null ? t('channel.created') : t('channel.saved') });
      router.refresh();
    })();
  }

  function remove(channel: ChannelView): Promise<void> {
    return (async () => {
      setDeleteError(null);
      const result = await call(
        channel.id,
        `/api/notifications/channels/${channel.id}`,
        { method: 'DELETE' },
        setDeleteError,
      );
      if (!result) return;
      setDeleting(null);
      toast({ title: t('channel.deleted', { name: channel.name }) });
      router.refresh();
    })();
  }

  function test(channel: ChannelView): void {
    void (async () => {
      setError(null);
      const result = (await call(
        `test:${channel.id}`,
        `/api/notifications/channels/${channel.id}/test`,
        { method: 'POST' },
        setError,
      )) as TestVerdict | null;
      if (!result) return;
      // Le verdict dit les deux temps : la sonde de configuration, puis l'envoi.
      toast({
        title: result.delivered
          ? t('test.delivered')
          : t('test.failed', { detail: result.error ?? t('test.noDetail') }),
        description: `${result.name} · ${
          result.probe.ok ? t('test.probe') : t('test.probeFailed')
        }${result.probe.detail}`,
        tone: result.delivered ? 'ok' : 'danger',
      });
      router.refresh();
    })();
  }

  const when = (iso: string) => formatDateTime(iso, format);

  return (
    <section className="card overflow-hidden">
      <div className="card-h">
        <div className="flex min-w-0 flex-col">
          <h2>{title}</h2>
          <span className="sub">{description}</span>
        </div>
        {canManage ? (
          <span className="ml-auto">
            <Button variant="secondary" size="sm" onClick={() => open(emptyDraft(catalog))}>
              <Plus aria-hidden />
              {t('channel.add')}
            </Button>
          </span>
        ) : null}
      </div>

      {error ? (
        <div className="border-b border-border-subtle px-4 py-3">
          <Alert variant="destructive">{error}</Alert>
        </div>
      ) : null}

      {initialChannels.length === 0 ? (
        <p className="t-sm px-4 py-4 text-text-3">{t('empty')}</p>
      ) : (
        <ul className="list">
          {initialChannels.map((channel) => {
            const descriptor = descriptorOf(channel.kind);
            return (
              <li key={channel.id} className="flex-col !items-stretch gap-1.5 !py-3.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[14px] font-semibold text-text">{channel.name}</span>
                  <Badge variant="outline">{descriptor?.label ?? channel.kind}</Badge>
                  <Badge variant={channel.enabled ? 'ok' : 'idle'} dot={channel.enabled}>
                    {channel.enabled ? t('channel.on') : t('channel.off')}
                  </Badge>
                  {channel.consecutiveFailures > 0 ? (
                    <Badge variant="danger">
                      {t('channel.failures', { count: channel.consecutiveFailures })}
                    </Badge>
                  ) : null}
                  {canManage ? (
                    <span className="ml-auto flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={pending === `test:${channel.id}`}
                        disabled={pending !== null}
                        onClick={() => test(channel)}
                      >
                        {pending === `test:${channel.id}` ? null : <Send aria-hidden />}
                        {pending === `test:${channel.id}` ? t('test.sending') : t('channel.test')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pending !== null}
                        onClick={() => open(draftFor(descriptor, channel))}
                      >
                        {tc('edit')}
                      </Button>
                      <IconButton
                        label={t('channel.delete.aria', { name: channel.name })}
                        size="icon-sm"
                        disabled={pending !== null}
                        onClick={() => {
                          setDeleteError(null);
                          setDeleting(channel);
                        }}
                      >
                        <Trash2 />
                      </IconButton>
                    </span>
                  ) : null}
                </div>

                <span className="t-cap text-text-2">
                  {channel.events.length === 0
                    ? t('channel.noEvents')
                    : t('channel.events', { list: channel.events.map(eventLabel).join(', ') })}
                </span>
                {channel.configuredSecrets.length > 0 ? (
                  <span className="t-cap text-text-3">
                    {t('channel.secrets', { list: channel.configuredSecrets.join(', ') })}
                  </span>
                ) : null}
                <span className="t-cap text-text-3">
                  {channel.lastSuccessAt
                    ? t('channel.lastSuccess', { at: when(channel.lastSuccessAt) })
                    : t('channel.never')}
                </span>
                {channel.lastError ? (
                  <span className="t-cap text-danger-text">
                    {t('channel.lastError', {
                      at: channel.lastFailureAt ? when(channel.lastFailureAt) : '?',
                      error: '',
                    })}
                    <span className="mono">{channel.lastError}</span>
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {canManage ? (
        <Drawer
          open={draft !== null}
          onOpenChange={(value) => (value ? undefined : setDraft(null))}
          label={draft?.id ? t('channel.edit.title', { name: draft.name }) : t('channel.add')}
        >
          {draft ? (
            <ChannelForm
              key={drawerKey}
              draft={draft}
              catalog={catalog}
              events={events}
              pending={pending === 'form'}
              error={formError}
              failures={editing?.consecutiveFailures ?? 0}
              onChange={setDraft}
              onCancel={() => setDraft(null)}
              onSubmit={submit}
              onTest={editing ? () => test(editing) : undefined}
            />
          ) : null}
        </Drawer>
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(value) => (value ? undefined : setDeleting(null))}
        level="trace"
        icon={<Trash2 />}
        title={deleting ? t('channel.delete.title', { name: deleting.name }) : ''}
        consequences={[t('channel.delete.events'), t('channel.delete.secrets')]}
        confirmLabel={t('channel.delete.confirm')}
        pending={deleting !== null && pending === deleting.id}
        error={deleteError}
        onConfirm={() => (deleting ? remove(deleting) : undefined)}
      />
    </section>
  );
}

function ChannelForm({
  draft,
  catalog,
  events,
  pending,
  error,
  failures,
  onChange,
  onCancel,
  onSubmit,
  onTest,
}: {
  draft: Draft;
  catalog: PresentedNotificationChannel[];
  events: PresentedNotificationEvent[];
  pending: boolean;
  error: string | null;
  failures: number;
  onChange: (draft: Draft) => void;
  onCancel: () => void;
  onSubmit: () => void;
  onTest?: () => void;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const language = useLanguage();
  const descriptor = catalog.find((entry) => entry.kind === draft.kind);

  return (
    <form
      className="contents"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <DrawerHeader
        icon={<Bell />}
        kind={t('drawer.kind')}
        title={draft.id ? t('channel.edit.title', { name: draft.name }) : t('channel.add')}
        state={
          failures > 0 ? (
            <Badge variant="danger">{t('channel.failures', { count: failures })}</Badge>
          ) : undefined
        }
      />
      <DrawerBody>
        {error ? <Alert variant="destructive">{error}</Alert> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="field">
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

          <div className="field">
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
          <p className="help">
            {descriptor.description} <span className="text-text-2">{descriptor.prerequisite}</span>
          </p>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          {(descriptor?.fields ?? []).map((field) => (
            <FieldInput key={field.name} field={field} draft={draft} onChange={onChange} />
          ))}
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="flex items-baseline gap-2">
            <span className="t-sm font-semibold text-text">{t('form.events.legend')}</span>
            <span className="t-cap text-text-3">
              {t('form.events.count', { count: draft.events.length, total: events.length })}
            </span>
          </legend>
          <p className="help">{t('form.events.help')}</p>
          <div className="grid gap-x-4 gap-y-2 pt-1 sm:grid-cols-2">
            {events.map((entry) => {
              const checked = draft.events.includes(entry.key as NotificationEventKey);
              return (
                <label
                  key={entry.key}
                  className="t-sm flex cursor-pointer items-start gap-2.5"
                  title={`${entry.rationale} (${notificationSeverityLabel(entry.severity, language).toLowerCase()})`}
                >
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
                  <span className="min-w-0 text-text">{entry.label}</span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <label className="t-sm flex items-center gap-2.5">
          <Switch
            checked={draft.enabled}
            onChange={(event) => onChange({ ...draft, enabled: event.target.checked })}
          />
          <span className="text-text">{t('form.enabled')}</span>
        </label>
      </DrawerBody>
      <DrawerFooter
        end={
          onTest ? (
            <Button type="button" variant="ghost" disabled={pending} onClick={onTest}>
              <Send aria-hidden />
              {t('channel.test')}
            </Button>
          ) : null
        }
      >
        <Button type="submit" loading={pending}>
          {pending ? tc('saving') : draft.id === null ? t('form.create') : tc('save')}
        </Button>
        <Button type="button" variant="ghost" disabled={pending} onClick={onCancel}>
          {tc('cancel')}
        </Button>
      </DrawerFooter>
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
      <label className="t-sm flex items-start gap-2.5 self-end rounded-lg border border-border px-3 py-2">
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
          {field.help ? <span className="help block">{field.help}</span> : null}
        </span>
      </label>
    );
  }

  const value = draft.values[field.name] ?? '';
  const update = (next: string) =>
    onChange({ ...draft, values: { ...draft.values, [field.name]: next } });

  return (
    <div className="field">
      <Label htmlFor={id}>
        {field.label}
        {field.required ? null : <span className="opt">{t('field.optional')}</span>}
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
          type={
            field.kind === 'password' ? 'password' : field.kind === 'number' ? 'number' : 'text'
          }
          value={value}
          placeholder={field.placeholder ?? undefined}
          autoComplete={field.secret ? 'new-password' : 'off'}
          onChange={(event) => update(event.target.value)}
        />
      )}

      {field.help ? <p className="help">{field.help}</p> : null}

      {field.secret && draft.id !== null ? (
        <p className="help">
          {t('field.secret.keep')}
          {field.required ? null : (
            <>
              {' '}
              <button
                type="button"
                className="btn btn-link t-cap"
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
