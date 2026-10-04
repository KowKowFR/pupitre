'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { TargetLabelList } from '@/components/target-label';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { DrawerBody, DrawerFooter } from '@/components/ui/drawer';
import { SecretInput } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { targets as messages } from '@/i18n/messages/targets';
import { cn } from '@/lib/utils';

/**
 * Mirror of `TARGET_DESCRIPTION_MAX` (`@pupitre/db`) — a client component does
 * not depend on the database. The real bound is the
 * `targets_description_length_check` constraint; this one only spares the user
 * from discovering the refusal afterwards.
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

/** What the API returns after creation. Only the fields the caller uses. */
export type CreatedTarget = { id: string; name: string };

export type TargetFormProps = {
  initial?: TargetFormValues;
  /**
   * An extension point for the onboarding assistant: creation stays exactly the
   * same — `POST /api/targets`, same fields, same 409, same audit — only what
   * follows changes. Without this callback, the form leaves the page, which makes
   * no sense in the middle of a guided journey. Absent: original behavior,
   * unchanged.
   */
  onCreated?: (target: CreatedTarget) => void;
  /** `null` removes the "Cancel" button — a guided journey has its own exit. */
  onCancel?: (() => void) | null;
  submitLabel?: string;
  /**
   * `drawer`: the fields in a drawer's scrolling body, the buttons in its footer —
   * the header stays with the caller. `page` (default): everything stacked.
   */
  frame?: 'page' | 'drawer';
};

export function TargetForm({
  initial,
  onCreated,
  onCancel,
  submitLabel,
  frame = 'page',
}: TargetFormProps) {
  const router = useRouter();
  const t = useT(messages);
  const tc = useT(common);
  const values = initial ?? EMPTY;
  const isEdit = Boolean(values.id);

  const [authMethod, setAuthMethod] = useState(values.authMethod);
  // Two fields held in state: one for its counter, the other to show the chips as
  // they will appear. A colored label is not chosen blindly in a text field.
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

    // When editing, a field left empty keeps the credential already in the
    // database: it is never prefilled, hence never sent back to the browser.
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
    router.push(`/targets?target=${target.id}`);
    router.refresh();
  }

  const fields = (
    <>
      {error ? <Alert variant="destructive">{error}</Alert> : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="field">
          <Label htmlFor="name">{t('field.name')}</Label>
          <Input id="name" name="name" defaultValue={values.name} required minLength={2} />
        </div>
        <div className="field">
          <Label htmlFor="sshUser">{t('field.sshUser')}</Label>
          <Input
            id="sshUser"
            name="sshUser"
            defaultValue={values.sshUser}
            required
            className="mono"
          />
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
        Under the machine's identity and before its secrets: the description
        answers "what is it?", not "how to connect to it?".
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
        {/* Cut around the `key=value` that the JSX renders monospaced: one key
            per fragment, in the order the sentence chains them. */}
        <p className="help">
          {t('labels.help.before')} <code>{t('labels.help.pair')}</code> {t('labels.help.after')}
        </p>
      </div>
    </>
  );

  const buttons = (
    <>
      <Button type="submit" loading={pending}>
        {pending ? tc('saving') : (submitLabel ?? (isEdit ? tc('save') : t('submit.create')))}
      </Button>
      {onCancel === null ? null : (
        <Button type="button" variant="ghost" onClick={onCancel ?? (() => router.back())}>
          {tc('cancel')}
        </Button>
      )}
    </>
  );

  if (frame === 'drawer') {
    return (
      <form onSubmit={onSubmit} className="contents">
        <DrawerBody>{fields}</DrawerBody>
        <DrawerFooter end={null}>{buttons}</DrawerFooter>
      </form>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5">
      {fields}
      <div className="flex gap-2">{buttons}</div>
    </form>
  );
}
