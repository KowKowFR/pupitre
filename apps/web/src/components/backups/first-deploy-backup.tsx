'use client';

import { CheckboxField } from '@/components/ui/checkbox';
import { useT } from '@/i18n/client';
import { backups as messages } from '@/i18n/messages/backups';

/**
 * At the first deployment of an application that has data: enable its automatic
 * backup right away, and the one that precedes each deployment. Adjustable
 * afterwards on its record.
 *
 * Without a destination, both boxes are greyed out and the screen says why:
 * enabling a pre-deployment backup without a destination would block every
 * following deployment.
 */
export type FirstDeployBackupChoice = { enabled: boolean; beforeDeploy: boolean };

export function FirstDeployBackup({
  value,
  onChange,
  hasDestination,
}: {
  value: FirstDeployBackupChoice;
  onChange: (value: FirstDeployBackupChoice) => void;
  hasDestination: boolean;
}) {
  const t = useT(messages);
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="t-sm mb-1 font-medium">{t('firstDeploy.title')}</legend>
      <CheckboxField
        label={t('firstDeploy.enabled')}
        help={t('firstDeploy.enabled.help')}
        checked={hasDestination && value.enabled}
        disabled={!hasDestination}
        onChange={(event) => onChange({ ...value, enabled: event.target.checked })}
      />
      <CheckboxField
        label={t('firstDeploy.beforeDeploy')}
        help={t('firstDeploy.beforeDeploy.help')}
        checked={hasDestination && value.beforeDeploy}
        disabled={!hasDestination}
        onChange={(event) => onChange({ ...value, beforeDeploy: event.target.checked })}
      />
      {hasDestination ? null : (
        <p className="t-cap text-text-3">{t('firstDeploy.noDestination')}</p>
      )}
    </fieldset>
  );
}

/** The choice as the API expects it — nothing when there is no destination. */
export function firstDeployPayload(
  value: FirstDeployBackupChoice,
  hasDestination: boolean,
): { backup: FirstDeployBackupChoice } | Record<string, never> {
  return hasDestination ? { backup: value } : {};
}
