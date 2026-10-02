'use client';

import { useState } from 'react';
import {
  SESSION_IDLE_HOURS,
  SESSION_MAX_HOURS,
  TWO_FACTOR_POLICIES,
  type AccountsSettings,
  type TwoFactorPolicy,
} from '@pupitre/core';
import { Alert } from '@/components/ui/alert';
import { Field } from '@/components/ui/field';
import { Radio } from '@/components/ui/radio';
import { Select } from '@/components/ui/select';
import { useT } from '@/i18n/client';
import { settings as messages } from '@/i18n/messages/settings';
import { SectionForm } from '../section-form';
import { useSettingsPatch } from '../use-settings-patch';

/** Ce qu'une politique exigerait, évalué côté serveur sur les rôles et comptes réels. */
export type PolicyReach = {
  /** Les rôles soumis, par leur libellé. */
  roles: string[];
  /** Les comptes soumis qui n'ont pas encore de second facteur. */
  missing: number;
  /** La personne qui règle en serait elle-même tenue, sans l'avoir. */
  self: boolean;
};

/**
 * Le second facteur exigé et la durée des sessions. Le PATCH ne porte que
 * `accounts` ; le serveur refuse une politique qui exigerait de son auteur un
 * second facteur qu'il n'a pas (`two_factor_self`).
 */
export function AccountsForm({
  settings,
  reach,
  sensitive,
  canManage,
}: {
  settings: AccountsSettings;
  reach: Record<TwoFactorPolicy, PolicyReach>;
  sensitive: string[];
  canManage: boolean;
}) {
  const t = useT(messages);
  const patch = useSettingsPatch();
  const [form, setForm] = useState<AccountsSettings>(settings);
  const disabled = !canManage;
  const current = reach[form.twoFactorPolicy];

  const duration = (hours: number) =>
    hours % 24 === 0
      ? t('accounts.days', { count: hours / 24 })
      : t('accounts.hours', { count: hours });

  function reset() {
    setForm(settings);
    patch.clearFeedback();
  }

  return (
    <SectionForm
      patch={patch}
      canManage={canManage}
      onReset={reset}
      onSubmit={() => void patch.save({ accounts: form })}
    >
      <fieldset className="flex flex-col gap-3">
        <legend className="t-sm mb-2 font-semibold text-text">
          {t('accounts.twoFactor.title')}
        </legend>
        <div
          role="radiogroup"
          aria-label={t('accounts.policy.label')}
          className="flex flex-col gap-2"
        >
          {TWO_FACTOR_POLICIES.map((policy) => (
            <Radio
              key={policy}
              name="two-factor-policy"
              value={policy}
              checked={form.twoFactorPolicy === policy}
              disabled={disabled}
              label={t(`accounts.policy.${policy}`)}
              help={t(`accounts.policy.${policy}.help`)}
              onChange={() => setForm((value) => ({ ...value, twoFactorPolicy: policy }))}
            />
          ))}
        </div>

        {form.twoFactorPolicy === 'sensitive' ? (
          <ul className="flex flex-wrap gap-1.5" aria-label={t('accounts.policy.sensitive')}>
            {sensitive.map((permission) => (
              <li
                key={permission}
                className="mono rounded-md bg-surface-2 px-2 py-0.5 text-[12px] text-text-2"
              >
                {permission}
              </li>
            ))}
          </ul>
        ) : null}

        {form.twoFactorPolicy !== 'off' ? (
          <>
            <p className="t-sm text-text-2">
              {current.roles.length > 0
                ? t('accounts.affected.roles', { roles: current.roles.join(', ') })
                : t('accounts.affected.none')}
            </p>
            {current.self ? (
              <Alert variant="destructive">{t('accounts.self.warning')}</Alert>
            ) : current.missing > 0 ? (
              <Alert variant="warn">{t('accounts.missing', { count: current.missing })}</Alert>
            ) : (
              <p className="t-sm text-text-2">{t('accounts.missing.none')}</p>
            )}
            <p className="help">{t('accounts.sso.note')}</p>
          </>
        ) : null}
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="t-sm mb-2 font-semibold text-text">
          {t('accounts.sessions.title')}
        </legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            label={t('accounts.idle.label')}
            help={t('accounts.idle.help')}
            htmlFor="session-idle"
          >
            <Select
              id="session-idle"
              value={String(form.sessionIdleHours)}
              disabled={disabled}
              onChange={(event) => {
                const hours = SESSION_IDLE_HOURS.find(
                  (item) => item === Number(event.target.value),
                );
                if (hours) setForm((value) => ({ ...value, sessionIdleHours: hours }));
              }}
            >
              {SESSION_IDLE_HOURS.map((hours) => (
                <option key={hours} value={hours}>
                  {duration(hours)}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label={t('accounts.max.label')}
            help={t('accounts.max.help')}
            htmlFor="session-max"
          >
            <Select
              id="session-max"
              value={form.sessionMaxHours === null ? '' : String(form.sessionMaxHours)}
              disabled={disabled}
              onChange={(event) => {
                const hours =
                  SESSION_MAX_HOURS.find((item) => item === Number(event.target.value)) ?? null;
                setForm((value) => ({ ...value, sessionMaxHours: hours }));
              }}
            >
              <option value="">{t('accounts.max.never')}</option>
              {SESSION_MAX_HOURS.map((hours) => (
                <option key={hours} value={hours}>
                  {duration(hours)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {form.sessionMaxHours !== null && form.sessionMaxHours < form.sessionIdleHours ? (
          <p className="help">{t('accounts.max.shorter')}</p>
        ) : null}
      </fieldset>
    </SectionForm>
  );
}
