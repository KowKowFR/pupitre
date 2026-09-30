import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * `<select>` natif habillé : même gabarit que `Input`, chevron en data-URI.
 * Le natif suffit ici — clavier, lecteurs d'écran et sélecteur mobile sont
 * ceux du système.
 */
function Select({ className, ...props }: React.ComponentProps<'select'>) {
  return <select data-slot="select" className={cn('select', className)} {...props} />;
}

export { Select };
