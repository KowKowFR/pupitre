'use client';

import { CheckboxField } from '@/components/ui/checkbox';
import { useT } from '@/i18n/client';
import { backups as messages } from '@/i18n/messages/backups';

/**
 * Au premier déploiement d'une application qui a des données : activer tout de
 * suite sa sauvegarde automatique, et celle qui précède chaque déploiement.
 * Réglable ensuite sur sa fiche.
 *
 * Sans destination, les deux cases sont grisées et l'écran dit pourquoi :
 * activer une sauvegarde avant déploiement sans destination bloquerait chaque
 * déploiement suivant.
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

/** Le choix tel que l'API l'attend — rien quand il n'y a pas de destination. */
export function firstDeployPayload(
  value: FirstDeployBackupChoice,
  hasDestination: boolean,
): { backup: FirstDeployBackupChoice } | Record<string, never> {
  return hasDestination ? { backup: value } : {};
}
