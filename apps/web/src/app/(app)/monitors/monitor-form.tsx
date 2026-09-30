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

/** Une sonde existante, telle que le formulaire de modification la reprend. */
export type EditableMonitor = {
  id: string;
  name: string;
  type: MonitorType;
  config: ConfigValues;
  intervalSeconds: number;
  failureThreshold: number;
  recoveryThreshold: number;
  /** L'URL est chiffrée en base et ne revient jamais au navigateur : on sait seulement qu'elle existe. */
  hasWebhook: boolean;
};

type ApiError = { error?: { message?: string } };

/** Les cadences proposées. Filtrées par le minimum que le type déclare. */
const INTERVAL_CHOICES = [30, 60, 300, 900, 3_600, 6 * 3_600, 12 * 3_600, 86_400];

/**
 * Le formulaire d'une sonde, en création comme en modification.
 *
 * Un seul formulaire pour les deux, parce que les deux disent la même chose :
 * ce qui est sondé, à quelle cadence, et quand une panne devient un incident.
 * Deux différences seulement :
 *
 *  - **le type ne se modifie pas.** Changer le type d'une sonde, c'est en créer
 *    une autre : son historique et ses incidents porteraient sur autre chose.
 *    Le serveur le refuse ; le formulaire l'affiche en lecture ;
 *  - **le webhook ne se relit pas.** Son URL est chiffrée en base et porte
 *    souvent un secret : elle ne revient pas au navigateur. On peut la
 *    remplacer ou la retirer ; laissé vide, le champ la conserve.
 */
export function MonitorForm(
  props: {
    types: TypeOption[];
    onDone: (name: string) => void;
  } & ({ mode: 'create'; app: AdoptableApp | null } | { mode: 'edit'; monitor: EditableMonitor }),
) {
  const { types, onDone } = props;
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
   * En modification, seul ce que l'opérateur a changé part au serveur.
   *
   * Ce n'est pas une économie : renvoyer la configuration la fait revalider,
   * résolution DNS comprise (garde SSRF). Changer un seuil ne doit pas échouer
   * parce que le nom de l'hôte ne se résout pas à cet instant — et le journal
   * ne doit montrer que ce qui a vraiment bougé.
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
    // Le webhook : une URL saisie le remplace, « Retirer » l'efface, rien ne le garde.
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

  // Une cadence réglée hors des choix proposés (par l'API) reste sélectionnable :
  // ouvrir le formulaire ne doit pas la changer en douce.
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
                Deux sorties existent pour la même panne. Le dire ici, au moment
                de saisir l'URL, est le seul endroit où l'information arrive à
                temps : sinon l'opérateur découvre le doublon en le recevant.
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
      </DrawerFooter>
    </form>
  );
}
