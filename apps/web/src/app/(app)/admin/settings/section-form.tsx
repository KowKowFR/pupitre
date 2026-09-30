'use client';

import type { ReactNode } from 'react';
import { useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { SettingsPatch } from './use-settings-patch';

/**
 * Enveloppe commune d'une sous-section modifiable : les deux bandeaux de
 * retour, et le couple Enregistrer / Annuler.
 *
 * Un vrai `<form>`, pas une `<div>` avec un bouton : la touche Entrée dans un
 * champ enregistre, ce qu'on attend d'un formulaire de réglages, et le bouton
 * de soumission est annoncé comme tel.
 *
 * Sans `settings:manage`, il n'y a pas de barre d'actions du tout. La mention
 * qui l'explique est posée une fois pour toutes par le layout de la section :
 * la répéter sur chaque panneau serait du bruit.
 */
export function SectionForm({
  patch,
  canManage,
  onSubmit,
  onReset,
  children,
}: {
  patch: SettingsPatch;
  canManage: boolean;
  onSubmit: () => void;
  onReset: () => void;
  children: ReactNode;
}) {
  const t = useT(common);

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      {patch.error ? <Alert variant="destructive">{patch.error}</Alert> : null}

      {children}

      {canManage ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-border-subtle pt-4">
          <Button type="submit" loading={patch.pending}>
            {patch.pending ? t('saving') : t('save')}
          </Button>
          <Button type="button" variant="ghost" disabled={patch.pending} onClick={onReset}>
            {t('reset')}
          </Button>
        </div>
      ) : null}
    </form>
  );
}
