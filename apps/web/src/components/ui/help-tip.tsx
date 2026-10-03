'use client';

import type * as React from 'react';
import { Info } from 'lucide-react';
import { useT } from '@/i18n/client';
import { chrome } from '@/i18n/messages/chrome';
import { cn } from '@/lib/utils';
import { Tooltip } from './tooltip';

/**
 * Une aide repliée dans une info-bulle : une petite icône à côté d'un
 * intitulé, l'explication au survol comme au focus. Pour les écrans denses,
 * où chaque champ portait deux lignes de prose qu'on ne lit qu'une fois.
 *
 * Un bouton, pour être atteint au clavier ; posé dans un `<label>`, il ne
 * coche ni ne focalise rien — un clic sur un élément interactif n'active pas
 * le libellé qui le contient.
 */
export function HelpTip({
  children,
  label,
  className,
}: {
  children: React.ReactNode;
  /** Nom accessible du bouton ; « Aide » par défaut. */
  label?: string;
  className?: string;
}) {
  const t = useT(chrome);
  return (
    <Tooltip content={children} wide>
      <button
        type="button"
        className={cn('help-tip', className)}
        aria-label={label ?? t('help.more')}
        onClick={(event) => event.preventDefault()}
      >
        <Info aria-hidden />
      </button>
    </Tooltip>
  );
}
