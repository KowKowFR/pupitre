'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  NOTIFICATION_SEVERITY_LABELS,
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
      setError(payload.error?.message ?? `Échec (HTTP ${response.status})`);
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
      setNotice(draft.id === null ? 'Canal créé.' : 'Canal enregistré.');
      router.refresh();
    })();
  }

  function remove(channel: ChannelView): void {
    void (async () => {
      const result = await call(`/api/notifications/channels/${channel.id}`, { method: 'DELETE' });
      if (!result) return;
      setNotice(`Canal « ${channel.name} » supprimé.`);
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
          <strong>{verdict.name}</strong> — {verdict.probe.ok ? 'sonde : ' : 'sonde en échec : '}
          {verdict.probe.detail}
          <br />
          {verdict.delivered
            ? "Message d'essai délivré. Allez vérifier qu'il est bien arrivé : le destinataire est le seul juge."
            : `Envoi en échec : ${verdict.error ?? 'sans détail'}`}
        </Alert>
      ) : null}

      {initialChannels.length === 0 ? (
        <Alert>
          Aucun canal configuré. Tant qu&apos;il n&apos;y en a pas, un déploiement en échec, un
          scan bloquant ou une réinitialisation de second facteur ne laissent de trace que dans
          les logs d&apos;activité — qu&apos;il faut penser à aller lire.
        </Alert>
      ) : (
        <ul className="flex flex-col gap-3">
          {initialChannels.map((channel) => {
            const descriptor = descriptorOf(channel.kind);
            return (
              <li key={channel.id} className="rounded-md border border-line p-3.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-ink">{channel.name}</span>
                  <Badge variant="secondary">{descriptor?.label ?? channel.kind}</Badge>
                  <Badge variant={channel.enabled ? 'ok' : 'outline'}>
                    {channel.enabled ? 'actif' : 'éteint'}
                  </Badge>
                  {channel.consecutiveFailures > 0 ? (
                    <Badge variant="destructive">
                      {channel.consecutiveFailures} échec
                      {channel.consecutiveFailures > 1 ? 's' : ''} d&apos;affilée
                    </Badge>
                  ) : null}
                </div>

                <p className="mt-1.5 text-xs text-ink-faint">
                  {channel.events.length === 0
                    ? 'Abonné à aucun événement — ce canal ne recevra jamais rien.'
                    : `Abonné à : ${channel.events.map(eventLabel).join(', ')}`}
                </p>

                {channel.configuredSecrets.length > 0 ? (
                  <p className="mt-1 text-xs text-ink-faint">
                    Secrets enregistrés : {channel.configuredSecrets.join(', ')} — chiffrés en
                    base, jamais renvoyés.
                  </p>
                ) : null}

                {channel.lastError ? (
                  <p className="mt-1.5 font-mono text-xs text-danger">
                    Dernier échec ({channel.lastFailureAt ?? '?'}) : {channel.lastError}
                  </p>
                ) : channel.lastSuccessAt ? (
                  <p className="mt-1.5 text-xs text-ink-faint">
                    Dernier envoi réussi : {channel.lastSuccessAt}
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
                      Modifier
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      type="button"
                      disabled={pending}
                      onClick={() => test(channel)}
                    >
                      {pending ? 'Envoi…' : "Envoyer un message d'essai"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      type="button"
                      disabled={pending}
                      onClick={() => remove(channel)}
                    >
                      Supprimer
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
            Ajouter un canal
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
  const descriptor = catalog.find((entry) => entry.kind === draft.kind);

  return (
    <form
      className="flex flex-col gap-4 rounded-md border border-line-strong bg-surface-2/40 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="channel-kind">Type de canal</Label>
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
          <Label htmlFor="channel-name">Nom</Label>
          <Input
            id="channel-name"
            value={draft.name}
            placeholder="astreinte"
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
          />
        </div>
      </div>

      {descriptor ? (
        <p className="text-xs text-ink-faint">
          {descriptor.description} <span className="text-ink-muted">{descriptor.prerequisite}</span>
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
        <legend className="eyebrow text-ink-muted">Événements notifiés</legend>
        <p className="text-xs text-ink-faint">
          Chaque événement retenu part sur ce canal. La liste est volontairement courte : un
          événement bavard rend la boîte inutilisable en une journée, et la première chose qu&apos;on
          fait alors est de tout couper.
        </p>
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
                  <span className="block text-ink">
                    {entry.label}{' '}
                    <span className="text-xs text-ink-faint">
                      ({NOTIFICATION_SEVERITY_LABELS[entry.severity].toLowerCase()})
                    </span>
                  </span>
                  <span className="block text-xs text-ink-faint">{entry.rationale}</span>
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
        <span className="text-ink">Canal actif</span>
      </label>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" type="submit" disabled={pending}>
          {pending ? 'Enregistrement…' : draft.id === null ? 'Créer le canal' : 'Enregistrer'}
        </Button>
        <Button size="sm" type="button" variant="ghost" disabled={pending} onClick={onCancel}>
          Annuler
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
  const id = `field-${field.name}`;

  if (field.kind === 'boolean') {
    return (
      <label className="flex items-start gap-2.5 self-end rounded-md border border-line px-3 py-2 text-sm">
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
          <span className="block text-ink">{field.label}</span>
          {field.help ? <span className="block text-xs text-ink-faint">{field.help}</span> : null}
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
        {field.required ? null : <span className="text-ink-faint">facultatif</span>}
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

      {field.help ? <p className="text-xs text-ink-faint">{field.help}</p> : null}

      {field.secret && draft.id !== null ? (
        <p className="text-xs text-ink-faint">
          Laisser vide conserve la valeur enregistrée.
          {field.required ? null : (
            <>
              {' '}
              <button
                type="button"
                className="text-signal underline-offset-4 hover:underline"
                onClick={() =>
                  onChange({
                    ...draft,
                    values: { ...draft.values, [field.name]: '' },
                    clearedSecrets: [...new Set([...draft.clearedSecrets, field.name])],
                  })
                }
              >
                Effacer ce secret
              </button>
              {draft.clearedSecrets.includes(field.name) ? ' — sera effacé.' : null}
            </>
          )}
        </p>
      ) : null}
    </div>
  );
}
