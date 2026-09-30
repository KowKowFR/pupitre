'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { TargetLabelList } from '@/components/target-label';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { SecretInput } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { targets as messages } from '@/i18n/messages/targets';
import { cn } from '@/lib/utils';

/**
 * Miroir de `TARGET_DESCRIPTION_MAX` (`@pupitre/db`) — un composant client ne
 * dépend pas de la base. La borne réelle est la contrainte
 * `targets_description_length_check` ; celle-ci ne fait qu'éviter à
 * l'utilisateur de découvrir le refus après coup.
 */
const DESCRIPTION_MAX = 280;

export type TargetFormValues = {
  id?: string;
  name: string;
  description: string | null;
  host: string;
  port: number;
  sshUser: string;
  authMethod: 'key' | 'password';
  sudoMethod: 'nopasswd' | 'password';
  portRangeStart: number;
  portRangeEnd: number;
  labels: Record<string, string>;
};

const EMPTY: TargetFormValues = {
  name: '',
  description: null,
  host: '',
  port: 22,
  sshUser: 'root',
  authMethod: 'key',
  sudoMethod: 'nopasswd',
  portRangeStart: 30_000,
  portRangeEnd: 32_767,
  labels: {},
};

function labelsToText(labels: Record<string, string>): string {
  return Object.entries(labels)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

function textToLabels(text: string): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (key && value) labels[key] = value;
  }
  return labels;
}

/** Ce que l'API rend après création. Seuls les champs dont l'appelant se sert. */
export type CreatedTarget = { id: string; name: string };

export type TargetFormProps = {
  initial?: TargetFormValues;
  /**
   * Point d'extension pour l'assistant de démarrage : la création reste
   * exactement la même — `POST /api/targets`, mêmes champs, même 409, même
   * audit — seule la suite change. Sans ce rappel, le formulaire quitte la
   * page, ce qui n'a aucun sens au milieu d'un parcours guidé.
   * Absent : comportement d'origine, inchangé.
   */
  onCreated?: (target: CreatedTarget) => void;
  /** `null` retire le bouton « Annuler » — un parcours guidé a sa propre sortie. */
  onCancel?: (() => void) | null;
  submitLabel?: string;
};

export function TargetForm({ initial, onCreated, onCancel, submitLabel }: TargetFormProps) {
  const router = useRouter();
  const t = useT(messages);
  const tc = useT(common);
  const values = initial ?? EMPTY;
  const isEdit = Boolean(values.id);

  const [authMethod, setAuthMethod] = useState(values.authMethod);
  // Deux champs tenus en état : l'un pour son compteur, l'autre pour montrer
  // les pastilles telles qu'elles apparaîtront. Une étiquette colorée ne se
  // choisit pas à l'aveugle dans un champ de texte.
  const [description, setDescription] = useState(values.description ?? '');
  const [labelsText, setLabelsText] = useState(labelsToText(values.labels));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const form = new FormData(event.currentTarget);
    const credential = String(form.get('credential') ?? '').trim();

    const payload: Record<string, unknown> = {
      name: String(form.get('name') ?? '').trim(),
      description: String(form.get('description') ?? ''),
      host: String(form.get('host') ?? '').trim(),
      port: Number(form.get('port') ?? 22),
      sshUser: String(form.get('sshUser') ?? '').trim(),
      authMethod: String(form.get('authMethod') ?? 'key'),
      sudoMethod: String(form.get('sudoMethod') ?? 'nopasswd'),
      portRangeStart: Number(form.get('portRangeStart') ?? 30_000),
      portRangeEnd: Number(form.get('portRangeEnd') ?? 32_767),
      labels: textToLabels(String(form.get('labels') ?? '')),
    };

    // En édition, un champ laissé vide conserve le credential déjà en base :
    // il n'est jamais pré-rempli, donc jamais réémis vers le navigateur.
    if (credential) payload.credential = credential;
    else if (!isEdit) {
      setError(
        authMethod === 'key' ? t('form.error.keyRequired') : t('form.error.passwordRequired'),
      );
      setPending(false);
      return;
    }

    const response = await fetch(isEdit ? `/api/targets/${values.id}` : '/api/targets', {
      method: isEdit ? 'PATCH' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
      setError(body.error?.message ?? tc('http.failure', { status: response.status }));
      setPending(false);
      return;
    }

    const target = (await response.json()) as CreatedTarget;
    if (onCreated) {
      setPending(false);
      onCreated(target);
      return;
    }
    router.push(`/targets/${target.id}`);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5">
      {error ? <Alert variant="destructive">{error}</Alert> : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="field">
          <Label htmlFor="name">{t('field.name')}</Label>
          <Input id="name" name="name" defaultValue={values.name} required minLength={2} />
        </div>
        <div className="field">
          <Label htmlFor="sshUser">{t('field.sshUser')}</Label>
          <Input id="sshUser" name="sshUser" defaultValue={values.sshUser} required className="mono" />
        </div>
        <div className="field">
          <Label htmlFor="host">{t('field.host')}</Label>
          <Input
            id="host"
            name="host"
            defaultValue={values.host}
            placeholder="10.0.0.12"
            required
            className="mono"
          />
        </div>
        <div className="field">
          <Label htmlFor="port">{t('field.port')}</Label>
          <Input
            id="port"
            name="port"
            type="number"
            min={1}
            max={65535}
            defaultValue={values.port}
            required
            className="mono"
          />
        </div>
        <div className="field">
          <Label htmlFor="authMethod">{t('field.authMethod')}</Label>
          <Select
            id="authMethod"
            name="authMethod"
            defaultValue={values.authMethod}
            onChange={(event) => setAuthMethod(event.target.value as 'key' | 'password')}
          >
            <option value="key">{t('auth.key')}</option>
            <option value="password">{t('auth.password')}</option>
          </Select>
        </div>
        <div className="field">
          <Label htmlFor="sudoMethod">{t('field.sudoMethod')}</Label>
          <Select id="sudoMethod" name="sudoMethod" defaultValue={values.sudoMethod}>
            <option value="nopasswd">{t('sudo.nopasswd')}</option>
            <option value="password">{t('sudo.password')}</option>
          </Select>
        </div>
      </div>

      {/*
        Sous l'identité de la machine et avant ses secrets : la description
        répond à « qu'est-ce que c'est ? », pas à « comment s'y connecter ? ».
      */}
      <div className="field">
        <Label htmlFor="description">{t('field.description')}</Label>
        <textarea
          id="description"
          name="description"
          rows={2}
          maxLength={DESCRIPTION_MAX}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder={t('description.placeholder')}
          className="textarea"
        />
        <p className="help flex justify-between gap-4">
          <span>{t('description.help')}</span>
          <span
            className={cn(
              'shrink-0 font-mono tabular-nums',
              description.length > DESCRIPTION_MAX - 40 ? 'text-warn-text' : 'text-text-3',
            )}
          >
            {description.length}/{DESCRIPTION_MAX}
          </span>
        </p>
      </div>

      <div className="field">
        <Label htmlFor="credential">
          {authMethod === 'key' ? t('field.credential.key') : t('field.credential.password')}
        </Label>
        {authMethod === 'key' ? (
          <textarea
            id="credential"
            name="credential"
            rows={8}
            spellCheck={false}
            autoComplete="off"
            placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n…'}
            className="textarea mono"
          />
        ) : (
          <SecretInput id="credential" name="credential" stored={isEdit} />
        )}
        <p className="help">
          {t('credential.help')}
          {isEdit ? t('credential.help.edit') : ''}
        </p>
      </div>

      <div className="field">
        <Label>{t('field.portRange')}</Label>
        <div className="flex items-center gap-2">
          <Input
            id="portRangeStart"
            name="portRangeStart"
            type="number"
            min={1024}
            max={65535}
            defaultValue={values.portRangeStart}
            required
            className="mono w-32"
          />
          <span className="text-sm text-text-3">→</span>
          <Input
            id="portRangeEnd"
            name="portRangeEnd"
            type="number"
            min={1024}
            max={65535}
            defaultValue={values.portRangeEnd}
            required
            className="mono w-32"
          />
        </div>
        <p className="help">{t('portRange.help')}</p>
      </div>

      <div className="field">
        <Label htmlFor="labels">{t('field.labels')}</Label>
        <textarea
          id="labels"
          name="labels"
          rows={3}
          value={labelsText}
          onChange={(event) => setLabelsText(event.target.value)}
          placeholder={'env=prod\nzone=eu-west'}
          className="textarea mono"
        />
        <TargetLabelList labels={textToLabels(labelsText)} className="pt-0.5" />
        {/* Coupée autour du `clé=valeur` que le JSX rend en chasse fixe : une clé
            par fragment, dans l'ordre où la phrase les enchaîne. */}
        <p className="help">
          {t('labels.help.before')} <code>{t('labels.help.pair')}</code> {t('labels.help.after')}
        </p>
      </div>

      <div className="flex gap-2">
        <Button type="submit" loading={pending}>
          {pending ? tc('saving') : (submitLabel ?? (isEdit ? tc('save') : t('submit.create')))}
        </Button>
        {onCancel === null ? null : (
          <Button type="button" variant="ghost" onClick={onCancel ?? (() => router.back())}>
            {tc('cancel')}
          </Button>
        )}
      </div>
    </form>
  );
}
