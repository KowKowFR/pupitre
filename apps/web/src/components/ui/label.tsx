import * as React from 'react';
import { cn } from '@/lib/utils';

/** A field label — 13/18, semi-bold, in sentence case. */
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
