import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Intitulé de champ — étiquette d'instrument : condensée, capitales, ouverte.
 * C'est ce qui donne aux formulaires du panel leur air de façade sérigraphiée.
 */
function Label({ className, ...props }: React.ComponentProps<'label'>) {
  return (
    <label
      data-slot="label"
      className={cn('eyebrow flex items-center gap-2 text-text-2 select-none', className)}
      {...props}
    />
  );
}

export { Label };
