import * as React from 'react';
import { cn } from '@/lib/utils';

/** `<select>` natif habillé — suffisant ici, sans dépendance Radix. */
function Select({ className, ...props }: React.ComponentProps<'select'>) {
  return (
    <select
      data-slot="select"
      className={cn(
        'field-select flex h-9 w-full rounded-md border border-border-strong bg-surface py-1 pr-8 pl-3',
        'text-sm text-text',
        'transition-[border-color,box-shadow] duration-100 ease-out',
        'outline-none focus-visible:border-accent focus-visible:ring-[3px] focus-visible:ring-accent/25',
        'hover:not-focus:border-text-3/60',
        'disabled:cursor-not-allowed disabled:bg-surface-2 disabled:opacity-60',
        className,
      )}
      {...props}
    />
  );
}

export { Select };
