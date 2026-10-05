'use client';

import { useState } from 'react';
import {
  SCANNER_KEYS,
  failOnLabel,
  failOnSchema,
  scannerLabel,
  type AppSettings,
  type FailOn,
  type ScannerKey,
} from '@pupitre/core';
import { Alert } from '@/components/ui/alert';
import { HelpTip } from '@/components/ui/help-tip';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { useLanguage, useT } from '@/i18n/client';
import { settings as messages } from '@/i18n/messages/settings';
import { SectionForm } from '../section-form';
import { useSettingsPatch } from '../use-settings-patch';

/**
 * The instance's scan policy.
 *
 * The PATCH only carries `security` — and the server-side merge is partial on
 * one level, so `disabledScanners` does replace the list instead of adding to
 * it, without the instance's name or the AI model moving.
 */
export function SecurityForm({
  settings,
  canManage,
}: {
  settings: AppSettings;
  canManage: boolean;
}) {
  const t = useT(messages);
  const language = useLanguage();
  const patch = useSettingsPatch();
  const [scanningEnabled, setScanningEnabled] = useState(settings.security.scanningEnabled);
  const [disabledScanners, setDisabledScanners] = useState<ScannerKey[]>(
    settings.security.disabledScanners,
  );
  const [failOn, setFailOn] = useState<FailOn>(settings.security.failOn);
  const [onlyFixable, setOnlyFixable] = useState(settings.security.onlyFixable);

  function reset() {
    setScanningEnabled(settings.security.scanningEnabled);
    setDisabledScanners(settings.security.disabledScanners);
    setFailOn(settings.security.failOn);
    setOnlyFixable(settings.security.onlyFixable);
    patch.clearFeedback();
  }

  return (
    <SectionForm
      patch={patch}
      canManage={canManage}
      onReset={reset}
      onSubmit={() =>
        void patch.save({ security: { scanningEnabled, disabledScanners, failOn, onlyFixable } })
      }
    >
      <label className="flex items-start gap-2.5 rounded-md border border-border px-3 py-2.5 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={scanningEnabled}
          disabled={!canManage}
          onChange={(event) => setScanningEnabled(event.target.checked)}
        />
        <span className="min-w-0">
          <span className="block text-text">
            {t('security.enabled.label')}
            <HelpTip>{t('security.enabled.help')}</HelpTip>
          </span>
        </span>
      </label>

      {scanningEnabled ? null : (
        <Alert variant="destructive">{t('security.disabled.warning')}</Alert>
      )}

      <div className="space-y-2">
        <span className="block text-sm text-text">
          {t('security.skipped.title')}
          <HelpTip>{t('security.skipped.help')}</HelpTip>
        </span>
        <div className="flex flex-wrap gap-2 pt-1">
          {SCANNER_KEYS.map((key) => {
            const off = disabledScanners.includes(key);
            return (
              <label
                key={key}
                className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs"
              >
                <input
                  type="checkbox"
                  checked={off}
                  disabled={!canManage || !scanningEnabled}
                  onChange={(event) => {
                    setDisabledScanners((current) =>
                      event.target.checked
                        ? [...current, key]
                        : current.filter((entry) => entry !== key),
                    );
                  }}
                />
                <span className={off ? 'text-text-3 line-through' : 'text-text'}>
                  {scannerLabel(key)}
                </span>
              </label>
            );
          })}
        </div>
      </div>

      <div className="field">
        <Label htmlFor="failOn">
          {t('security.failOn.label')}
          <HelpTip>
            {t('security.failOn.help')}
            <span className="mt-1.5 block">{t('security.frozen')}</span>
          </HelpTip>
        </Label>
        <Select
          id="failOn"
          className="w-full sm:w-72"
          value={failOn}
          disabled={!canManage || !scanningEnabled}
          onChange={(event) => setFailOn(failOnSchema.parse(event.target.value))}
        >
          {failOnSchema.options.map((option) => (
            <option key={option} value={option}>
              {failOnLabel(option, language)}
            </option>
          ))}
        </Select>
      </div>

      <label className="flex items-start gap-2.5 rounded-md border border-border px-3 py-2.5 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={onlyFixable}
          disabled={!canManage || !scanningEnabled || failOn === 'NONE'}
          onChange={(event) => setOnlyFixable(event.target.checked)}
        />
        <span className="min-w-0">
          <span className="block text-text">
            {t('security.onlyFixable.label')}
            <HelpTip>{t('security.onlyFixable.help')}</HelpTip>
          </span>
        </span>
      </label>
    </SectionForm>
  );
}
