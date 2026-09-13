import * as React from 'react';
import { cn } from '@/lib/utils';

/** `<select>` natif habillé — suffisant ici, sans dépendance Radix. */
function Select({ className, ...props }: React.ComponentProps<'select'>) {
  return (
    <select
      data-slot="select"
      className={cn(
        'field-select flex h-9 w-full rounded-md border border-line-strong bg-surface py-1 pr-8 pl-3',
        'text-sm text-ink',
        'transition-[border-color,box-shadow] duration-100 ease-out',
        'outline-none focus-visible:border-signal focus-visible:ring-[3px] focus-visible:ring-signal/25',
        'hover:not-focus:border-ink-faint/60',
        'disabled:cursor-not-allowed disabled:bg-surface-2 disabled:opacity-60',
        className,
      )}
      {...props}
    />
  );
}

export { Select };
