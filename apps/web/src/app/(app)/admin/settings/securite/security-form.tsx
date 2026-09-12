'use client';

import { useState } from 'react';
import {
  FAIL_ON_LABELS,
  SCANNER_KEYS,
  failOnSchema,
  scannerLabel,
  type AppSettings,
  type FailOn,
  type ScannerKey,
} from '@pupitre/core';
import { Alert } from '@/components/ui/alert';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
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
      onSubmit={() =>
        void patch.save({ security: { scanningEnabled, disabledScanners, failOn } })
      }
    >
      <label className="flex items-start gap-2.5 rounded-md border border-line px-3 py-2.5 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={scanningEnabled}
          disabled={!canManage}
          onChange={(event) => setScanningEnabled(event.target.checked)}
        />
        <span className="min-w-0">
          <span className="block text-ink">Analyser les images avant déploiement</span>
          <span className="block text-xs text-ink-faint">
            Décocher coupe l&apos;étape pour tout le monde, même si un déploiement demande
            explicitement des scanners.
          </span>
        </span>
      </label>

      {scanningEnabled ? null : (
        <Alert variant="destructive">
          Plus aucune image ne sera analysée. Les vulnérabilités connues des dépendances de vos
          applications passeront sans être signalées, et le seuil de blocage devient sans effet.
        </Alert>
      )}

      <div className="space-y-2">
        <span className="block text-sm text-ink">Scanners écartés</span>
        <p className="text-xs text-ink-faint">
          Utile quand un seul scanner pose problème — une base de vulnérabilités inaccessible
          depuis la machine cible, par exemple. Les autres continuent de tourner.
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          {SCANNER_KEYS.map((key) => {
            const off = disabledScanners.includes(key);
            return (
              <label
                key={key}
                className="flex items-center gap-2 rounded-md border border-line px-2.5 py-1.5 text-xs"
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
                <span className={off ? 'text-ink-faint line-through' : 'text-ink'}>
                  {scannerLabel(key)}
                </span>
              </label>
            );
          })}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="failOn">Seuil de blocage</Label>
        <Select
          id="failOn"
          className="w-full sm:w-72"
          value={failOn}
          disabled={!canManage || !scanningEnabled}
          onChange={(event) => setFailOn(failOnSchema.parse(event.target.value))}
        >
          {failOnSchema.options.map((option) => (
            <option key={option} value={option}>
              {FAIL_ON_LABELS[option]}
            </option>
          ))}
        </Select>
        <p className="text-xs text-ink-faint">
          Sévérité à partir de laquelle un finding empêche la mise en ligne. Ce seuil vaut pour
          toute l&apos;instance : l&apos;écran de déploiement ne le demande plus, une politique de
          sécurité qui se rediscute à chaque mise en ligne n&apos;en est pas une.
        </p>
      </div>

      <p className="text-xs text-ink-faint">
        Le réglage s&apos;applique au moment où un déploiement est enfilé, et la configuration
        retenue est gelée avec lui : réactiver l&apos;analyse ne relance pas ce qui est déjà en
        file. Chaque modification est tracée dans les logs d&apos;activité.
      </p>
    </SectionForm>
  );
}
