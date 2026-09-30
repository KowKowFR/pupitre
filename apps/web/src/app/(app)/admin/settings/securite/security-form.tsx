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
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { useLanguage, useT } from '@/i18n/client';
import { settings as messages } from '@/i18n/messages/settings';
import { SectionForm } from '../section-form';
import { useSettingsPatch } from '../use-settings-patch';

/**
 * Politique de scan de l'instance.
 *
 * Le PATCH ne porte que `security` — et la fusion serveur est partielle sur un
 * niveau, donc `disabledScanners` remplace bien la liste au lieu de s'y
 * ajouter, sans que le nom de l'instance ou le modèle d'IA ne bougent.
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

  function reset() {
    setScanningEnabled(settings.security.scanningEnabled);
    setDisabledScanners(settings.security.disabledScanners);
    setFailOn(settings.security.failOn);
    patch.clearFeedback();
  }

  return (
    <SectionForm
      patch={patch}
      canManage={canManage}
      onReset={reset}
      onSubmit={() => void patch.save({ security: { scanningEnabled, disabledScanners, failOn } })}
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
          <span className="block text-text">{t('security.enabled.label')}</span>
          <span className="help block">{t('security.enabled.help')}</span>
        </span>
      </label>

      {scanningEnabled ? null : (
        <Alert variant="destructive">{t('security.disabled.warning')}</Alert>
      )}

      <div className="space-y-2">
        <span className="block text-sm text-text">{t('security.skipped.title')}</span>
        <p className="help">{t('security.skipped.help')}</p>
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
        <Label htmlFor="failOn">{t('security.failOn.label')}</Label>
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
        <p className="help">{t('security.failOn.help')}</p>
      </div>

      <p className="help">{t('security.frozen')}</p>
    </SectionForm>
  );
}
