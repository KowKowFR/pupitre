'use client';

import { useState } from 'react';
import { LOCALE_LABELS, SCANNER_KEYS, scannerLabel, type ScannerKey } from '@pupitre/core';
import type { AppSettings, DateStyleName, SupportedLocale } from '@pupitre/core';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { onboarding } from '@/i18n/messages/onboarding';
import { formatDateTime } from '@/lib/format';

/**
 * The two steps that have no form to reuse: they write into the instance
 * settings, and `PATCH /api/settings` accepts a *partial* patch. That is what
 * allows the assistant to only send what it shows — the time zone here, the
 * scanners there — without resetting along the way a setting it does not show.
 * No validation is redone on the client side: the route's Zod schema stays the
 * only judge.
 */

type ApiError = { error?: { message?: string } };

/** A fixed instant: two separate `new Date()` would produce two different renderings. */
const PREVIEW_INSTANT = new Date('2026-01-15T14:32:07Z');

/**
 * `httpFailure` is passed by the caller rather than rendered here: this function
 * is not a component, so it has no `t`. The fallback stays a sentence of the
 * shared dictionary, the same as everywhere else in the panel.
 */
async function patchSettings(
  body: Record<string, unknown>,
  httpFailure: (status: number) => string,
): Promise<string | null> {
  const response = await fetch('/api/settings', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (response.ok) return null;
  const payload = (await response.json().catch(() => ({}))) as ApiError;
  return payload.error?.message ?? httpFailure(response.status);
}

export function IdentityStep({
  settings,
  timezones,
  locales,
  dateStyles,
  disabled,
  onSaved,
}: {
  settings: AppSettings;
  timezones: string[];
  locales: SupportedLocale[];
  dateStyles: DateStyleName[];
  disabled: boolean;
  onSaved: () => void;
}) {
  const t = useT(onboarding);
  const tc = useT(common);
  const [instanceName, setInstanceName] = useState(settings.instanceName);
  const [instanceTagline, setInstanceTagline] = useState(settings.instanceTagline);
  const [timezone, setTimezone] = useState(settings.timezone);
  const [locale, setLocale] = useState<SupportedLocale>(settings.locale);
  const [dateStyle, setDateStyle] = useState<DateStyleName>(settings.dateStyle);
  const [timeStyle, setTimeStyle] = useState<DateStyleName>(settings.timeStyle);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const styleLabel: Record<DateStyleName, string> = {
    short: t('style.short'),
    medium: t('style.medium'),
    long: t('style.long'),
  };

  const preview = formatDateTime(PREVIEW_INSTANT, { timezone, locale, dateStyle, timeStyle });

  async function save() {
    setPending(true);
    const message = await patchSettings(
      {
        instanceName,
        instanceTagline,
        timezone,
        locale,
        dateStyle,
        timeStyle,
      },
      (status) => tc('http.failure', { status }),
    );
    setError(message);
    setPending(false);
    if (!message) onSaved();
  }

  return (
    <div className="flex flex-col gap-4">
      {error ? <Alert variant="destructive">{error}</Alert> : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="field">
          <Label htmlFor="ob-name">{t('identity.name.label')}</Label>
          <Input
            id="ob-name"
            value={instanceName}
            maxLength={40}
            onChange={(event) => setInstanceName(event.target.value)}
          />
        </div>
        <div className="field">
          <Label htmlFor="ob-tagline">{t('identity.tagline.label')}</Label>
          <Input
            id="ob-tagline"
            value={instanceTagline}
            maxLength={60}
            placeholder={t('identity.tagline.placeholder')}
            onChange={(event) => setInstanceTagline(event.target.value)}
          />
        </div>
        <div className="field">
          <Label htmlFor="ob-timezone">{t('identity.timezone.label')}</Label>
          <Select
            id="ob-timezone"
            value={timezone}
            onChange={(event) => setTimezone(event.target.value)}
          >
            {timezones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </Select>
        </div>
        <div className="field">
          <Label htmlFor="ob-locale">{t('identity.locale.label')}</Label>
          {/*
            The same selector as in the Regional settings section, and not one
            more "language" setting: the locale already decides the months'
            names, it also decides the words. The labels are `LOCALE_LABELS`' —
            each language names itself in its own language, so that an English
            speaker recognizes their row on a screen in French.
                     */}
          <Select
            id="ob-locale"
            value={locale}
            onChange={(event) => setLocale(event.target.value as SupportedLocale)}
          >
            {locales.map((item) => (
              <option key={item} value={item}>
                {LOCALE_LABELS[item]}
              </option>
            ))}
          </Select>
          <p className="help">{t('identity.locale.help')}</p>
        </div>
        <div className="field">
          <Label htmlFor="ob-date-style">{t('identity.dateStyle.label')}</Label>
          <Select
            id="ob-date-style"
            value={dateStyle}
            onChange={(event) => setDateStyle(event.target.value as DateStyleName)}
          >
            {dateStyles.map((style) => (
              <option key={style} value={style}>
                {styleLabel[style]}
              </option>
            ))}
          </Select>
        </div>
        <div className="field">
          <Label htmlFor="ob-time-style">{t('identity.timeStyle.label')}</Label>
          <Select
            id="ob-time-style"
            value={timeStyle}
            onChange={(event) => setTimeStyle(event.target.value as DateStyleName)}
          >
            {dateStyles.map((style) => (
              <option key={style} value={style}>
                {styleLabel[style]}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div className="well">
        <div className="t-cap font-medium text-text-3">{t('preview.title')}</div>
        <div className="mt-1 mono text-sm text-text tabular-nums">{preview}</div>
        <div className="help mt-1">{t('preview.help')}</div>
      </div>

      <div>
        <Button size="sm" disabled={pending || disabled} onClick={() => void save()}>
          {pending ? tc('saving') : t('action.saveAndContinue')}
        </Button>
      </div>
    </div>
  );
}

export function SecurityStep({
  settings,
  aiApiKeyConfigured,
  aiApiKeyLast4,
  disabled,
  onSaved,
}: {
  settings: AppSettings;
  aiApiKeyConfigured: boolean;
  aiApiKeyLast4: string | null;
  disabled: boolean;
  onSaved: () => void;
}) {
  const t = useT(onboarding);
  const tc = useT(common);
  const [scanningEnabled, setScanningEnabled] = useState(settings.security.scanningEnabled);
  const [disabledScanners, setDisabledScanners] = useState<ScannerKey[]>(
    settings.security.disabledScanners,
  );
  const [aiEnabled, setAiEnabled] = useState(settings.ai.enabled);
  /** Never prefilled: the key does not come out of the database, even masked. */
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function save() {
    setPending(true);
    const body: Record<string, unknown> = {
      security: { scanningEnabled, disabledScanners },
      ai: { enabled: aiEnabled },
    };
    // Empty field = key unchanged. The property is only present if one really wants
    // to set a key — the same distinction as on the settings screen.
    if (apiKeyInput.trim() !== '') body.aiApiKey = apiKeyInput.trim();

    const message = await patchSettings(body, (status) => tc('http.failure', { status }));
    setError(message);
    setPending(false);
    if (!message) {
      setApiKeyInput('');
      onSaved();
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {error ? <Alert variant="destructive">{error}</Alert> : null}

      <label className="flex items-start gap-2.5 rounded-md border border-border px-3 py-2.5 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={scanningEnabled}
          onChange={(event) => setScanningEnabled(event.target.checked)}
        />
        <span className="min-w-0">
          <span className="block text-text">{t('security.scan.label')}</span>
          <span className="help block">{t('security.scan.help')}</span>
        </span>
      </label>

      {scanningEnabled ? (
        <div className="space-y-2">
          <span className="block text-sm text-text">{t('security.scanners.label')}</span>
          <div className="flex flex-wrap gap-2">
            {SCANNER_KEYS.map((key) => {
              const off = disabledScanners.includes(key);
              return (
                <label
                  key={key}
                  className="t-cap flex items-center gap-2 rounded-lg border border-border px-2.5 py-1.5"
                >
                  <input
                    type="checkbox"
                    checked={off}
                    onChange={(event) =>
                      setDisabledScanners((current) =>
                        event.target.checked
                          ? [...current, key]
                          : current.filter((entry) => entry !== key),
                      )
                    }
                  />
                  <span className={off ? 'text-text-3 line-through' : 'text-text'}>
                    {scannerLabel(key)}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      ) : (
        <Alert variant="destructive">{t('security.scan.off')}</Alert>
      )}

      <label className="flex items-start gap-2.5 rounded-md border border-border px-3 py-2.5 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={aiEnabled}
          onChange={(event) => setAiEnabled(event.target.checked)}
        />
        <span className="min-w-0">
          <span className="block text-text">{t('security.ai.label')}</span>
          <span className="help block">{t('security.ai.help')}</span>
        </span>
      </label>

      <div className="field">
        <Label htmlFor="ob-api-key">{t('security.apiKey.label')}</Label>
        <Input
          id="ob-api-key"
          type="password"
          autoComplete="off"
          value={apiKeyInput}
          /*
            Three sentences rather than a sentence with holes: the variant with the
            last four characters places this fragment elsewhere depending on the
            language, and a `${}` in the middle of a translated string would have
            frozen it in French.
          */
          placeholder={
            aiApiKeyConfigured
              ? aiApiKeyLast4
                ? t('security.apiKey.placeholder.storedLast4', { last4: aiApiKeyLast4 })
                : t('security.apiKey.placeholder.stored')
              : t('security.apiKey.placeholder.none')
          }
          onChange={(event) => setApiKeyInput(event.target.value)}
        />
        <p className="help">
          {t('security.apiKey.help.before')} <code className="mono">MASTER_KEY</code>
          {t('security.apiKey.help.after')}
        </p>
      </div>

      <div>
        <Button size="sm" disabled={pending || disabled} onClick={() => void save()}>
          {pending ? tc('saving') : t('action.saveAndContinue')}
        </Button>
      </div>
    </div>
  );
}
