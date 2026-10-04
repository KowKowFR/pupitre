'use client';

import { useState } from 'react';
import { ArrowUp, Copy, Plus, X } from 'lucide-react';
import type { SsoSettings } from '@pupitre/core';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CheckboxField } from '@/components/ui/checkbox';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useT } from '@/i18n/client';
import { settings as messages } from '@/i18n/messages/settings';
import { toast } from '@/lib/toast';
import { SectionForm } from '../section-form';
import { useSettingsPatch } from '../use-settings-patch';

type Mapping = SsoSettings['roleMappings'][number];
type Check = { ok: true; issuer: string } | { ok: false; error: string } | null;

/**
 * Single sign-on: the provider, the accounts, the roles.
 *
 * The PATCH only carries `sso` — and the secret, only if it was typed in or
 * cleared: left empty, it stays the stored one, and never comes back from the
 * server.
 */
export function SsoForm({
  settings,
  secretConfigured,
  status,
  callbackUrl,
  roles,
  canManage,
}: {
  settings: SsoSettings;
  secretConfigured: boolean;
  status: { active: boolean; error: string | null };
  callbackUrl: string;
  roles: Array<{ key: string; label: string }>;
  canManage: boolean;
}) {
  const t = useT(messages);
  const patch = useSettingsPatch();
  const [form, setForm] = useState<SsoSettings>(settings);
  const [secret, setSecret] = useState('');
  const [clearSecret, setClearSecret] = useState(false);
  const [check, setCheck] = useState<Check>(null);
  const [checking, setChecking] = useState(false);
  const disabled = !canManage;
  const set = <K extends keyof SsoSettings>(key: K, value: SsoSettings[K]) =>
    setForm((current) => ({ ...current, [key]: value }));
  const setMappings = (update: (current: Mapping[]) => Mapping[]) =>
    setForm((current) => ({ ...current, roleMappings: update(current.roleMappings) }));

  function reset() {
    setForm(settings);
    setSecret('');
    setClearSecret(false);
    setCheck(null);
    patch.clearFeedback();
  }

  async function save() {
    const ok = await patch.save({
      sso: {
        ...form,
        roleMappings: form.roleMappings.filter((mapping) => mapping.group.trim() !== ''),
      },
      ...(clearSecret
        ? { ssoClientSecret: null }
        : secret.trim()
          ? { ssoClientSecret: secret.trim() }
          : {}),
    });
    if (ok) {
      setSecret('');
      setClearSecret(false);
    }
  }

  async function test() {
    setChecking(true);
    setCheck(null);
    const response = await fetch('/api/settings/sso/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ issuer: form.issuer }),
    }).catch(() => null);
    setChecking(false);
    const body = (await response?.json().catch(() => null)) as
      | { ok: true; issuer: string }
      | { ok: false; error: string }
      | { error?: { message?: string } }
      | null;
    if (body && 'ok' in body) setCheck(body);
    else setCheck({ ok: false, error: (body && 'error' in body && body.error?.message) || '?' });
  }

  async function copyCallback() {
    try {
      await navigator.clipboard.writeText(callbackUrl);
      toast({ title: t('sso.callback.copied'), tone: 'ok' });
    } catch {
      /* the URL stays on screen, selectable */
    }
  }

  return (
    <SectionForm patch={patch} canManage={canManage} onReset={reset} onSubmit={() => void save()}>
      <CheckboxField
        label={t('sso.enabled.label')}
        help={t('sso.enabled.help')}
        checked={form.enabled}
        disabled={disabled}
        onChange={(event) => set('enabled', event.target.checked)}
      />
      {settings.enabled && status.active ? (
        <Alert variant="success">{t('sso.status.active', { label: settings.label })}</Alert>
      ) : null}
      {settings.enabled && status.error ? (
        <Alert variant="warn">{t('sso.status.error', { error: status.error })}</Alert>
      ) : null}

      <fieldset className="flex flex-col gap-4">
        <legend className="t-sm mb-2 font-semibold text-text">{t('sso.provider.title')}</legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[14rem_1fr]">
          <Field label={t('sso.label.label')} help={t('sso.label.help')} htmlFor="sso-label">
            <Input
              id="sso-label"
              value={form.label}
              maxLength={40}
              disabled={disabled}
              onChange={(event) => set('label', event.target.value)}
            />
          </Field>
          <div className="flex items-end gap-2">
            <Field
              label={t('sso.issuer.label')}
              help={t('sso.issuer.help')}
              htmlFor="sso-issuer"
              className="min-w-0 flex-1"
            >
              <Input
                id="sso-issuer"
                value={form.issuer}
                placeholder={t('sso.issuer.placeholder')}
                disabled={disabled}
                className="mono"
                onChange={(event) => {
                  set('issuer', event.target.value);
                  setCheck(null);
                }}
              />
            </Field>
            <Button
              type="button"
              variant="secondary"
              loading={checking}
              disabled={disabled || form.issuer.trim() === ''}
              onClick={() => void test()}
              className="mb-6"
            >
              {t('sso.check')}
            </Button>
          </div>
        </div>
        {check ? (
          <Alert variant={check.ok ? 'success' : 'destructive'}>
            {check.ok
              ? t('sso.check.ok', { issuer: check.issuer })
              : t('sso.check.failed', { error: check.error })}
          </Alert>
        ) : null}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t('sso.clientId.label')} help={t('sso.clientId.help')} htmlFor="sso-client">
            <Input
              id="sso-client"
              value={form.clientId}
              disabled={disabled}
              className="mono"
              onChange={(event) => set('clientId', event.target.value)}
            />
          </Field>
          <Field
            label={t('sso.clientSecret.label')}
            help={t('sso.clientSecret.help')}
            htmlFor="sso-secret"
          >
            <Input
              id="sso-secret"
              type="password"
              autoComplete="off"
              value={secret}
              disabled={disabled || clearSecret}
              placeholder={
                secretConfigured
                  ? t('sso.clientSecret.placeholder.set')
                  : t('sso.clientSecret.placeholder.none')
              }
              onChange={(event) => setSecret(event.target.value)}
            />
          </Field>
        </div>
        {secretConfigured ? (
          <CheckboxField
            label={t('sso.clientSecret.clear')}
            checked={clearSecret}
            disabled={disabled}
            onChange={(event) => setClearSecret(event.target.checked)}
          />
        ) : null}
        <Field label={t('sso.scopes.label')} help={t('sso.scopes.help')} htmlFor="sso-scopes">
          <Input
            id="sso-scopes"
            value={form.scopes}
            disabled={disabled}
            className="mono"
            onChange={(event) => set('scopes', event.target.value)}
          />
        </Field>
        <div className="flex items-end gap-2">
          <Field
            label={t('sso.callback.label')}
            help={t('sso.callback.help')}
            htmlFor="sso-callback"
            className="min-w-0 flex-1"
          >
            <Input
              readOnly
              value={callbackUrl}
              className="mono"
              onFocus={(event) => event.currentTarget.select()}
            />
          </Field>
          <Button
            type="button"
            variant="secondary"
            className="mb-6"
            onClick={() => void copyCallback()}
          >
            <Copy aria-hidden />
            {t('sso.callback.copy')}
          </Button>
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="t-sm mb-2 font-semibold text-text">{t('sso.accounts.title')}</legend>
        <CheckboxField
          label={t('sso.autoCreate.label')}
          help={t('sso.autoCreate.help')}
          checked={form.autoCreate}
          disabled={disabled}
          onChange={(event) => set('autoCreate', event.target.checked)}
        />
        <CheckboxField
          label={t('sso.linkByEmail.label')}
          help={t('sso.linkByEmail.help')}
          checked={form.linkByEmail}
          disabled={disabled}
          onChange={(event) => set('linkByEmail', event.target.checked)}
        />
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="t-sm mb-2 font-semibold text-text">{t('sso.roles.title')}</legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            label={t('sso.groupsClaim.label')}
            help={t('sso.groupsClaim.help')}
            htmlFor="sso-claim"
          >
            <Input
              id="sso-claim"
              value={form.groupsClaim}
              disabled={disabled}
              className="mono"
              onChange={(event) => set('groupsClaim', event.target.value)}
            />
          </Field>
          <Field
            label={t('sso.defaultRole.label')}
            help={t('sso.defaultRole.help')}
            htmlFor="sso-default-role"
          >
            <Select
              id="sso-default-role"
              value={form.defaultRole}
              disabled={disabled}
              onChange={(event) => set('defaultRole', event.target.value)}
            >
              {roles.map((role) => (
                <option key={role.key} value={role.key}>
                  {role.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <CheckboxField
          label={t('sso.syncRoles.label')}
          help={t('sso.syncRoles.help')}
          checked={form.syncRoles}
          disabled={disabled}
          onChange={(event) => set('syncRoles', event.target.checked)}
        />
        <div className="flex flex-col gap-2">
          <span className="t-sm text-text">{t('sso.mappings.label')}</span>
          <p className="help">{t('sso.mappings.help')}</p>
          {form.roleMappings.length === 0 ? (
            <p className="t-cap text-text-3">{t('sso.mappings.empty')}</p>
          ) : (
            <ol className="flex flex-col gap-2">
              {form.roleMappings.map((mapping, index) => (
                <li key={index} className="flex items-center gap-2">
                  <Input
                    aria-label={t('sso.mappings.group')}
                    value={mapping.group}
                    placeholder={t('sso.mappings.group')}
                    disabled={disabled}
                    className="mono min-w-0 flex-1"
                    onChange={(event) =>
                      setMappings((current) =>
                        current.map((entry, i) =>
                          i === index ? { ...entry, group: event.target.value } : entry,
                        ),
                      )
                    }
                  />
                  <Select
                    aria-label={t('sso.mappings.role')}
                    value={mapping.role}
                    disabled={disabled}
                    className="w-44"
                    onChange={(event) =>
                      setMappings((current) =>
                        current.map((entry, i) =>
                          i === index ? { ...entry, role: event.target.value } : entry,
                        ),
                      )
                    }
                  >
                    {roles.map((role) => (
                      <option key={role.key} value={role.key}>
                        {role.label}
                      </option>
                    ))}
                  </Select>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={disabled || index === 0}
                    aria-label={t('sso.mappings.up', { group: mapping.group })}
                    onClick={() =>
                      setMappings((current) => {
                        const next = [...current];
                        [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                        return next;
                      })
                    }
                  >
                    <ArrowUp aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={disabled}
                    aria-label={t('sso.mappings.remove', { group: mapping.group })}
                    onClick={() => setMappings((current) => current.filter((_, i) => i !== index))}
                  >
                    <X aria-hidden />
                  </Button>
                </li>
              ))}
            </ol>
          )}
          {canManage ? (
            <div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() =>
                  setMappings((current) => [
                    ...current,
                    {
                      group: '',
                      role: roles.find((role) => role.key === 'viewer')?.key ?? form.defaultRole,
                    },
                  ])
                }
              >
                <Plus aria-hidden />
                {t('sso.mappings.add')}
              </Button>
            </div>
          ) : null}
        </div>
      </fieldset>
    </SectionForm>
  );
}
