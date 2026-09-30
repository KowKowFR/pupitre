import * as React from 'react';
import { cn } from '@/lib/utils';

/** Intitulé de champ — 13/18, semi-gras, en casse de phrase. */
function Label({ className, ...props }: React.ComponentProps<'label'>) {
  return (
    <label
      data-slot="label"
      className={cn('label flex items-center gap-2 select-none', className)}
      {...props}
    />
  );
}

export { Label };
