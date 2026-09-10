import * as React from 'react';
import { cn } from '@/lib/utils';

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'flex h-9 w-full min-w-0 rounded-md border border-line-strong bg-surface px-3 py-1',
        'text-base text-ink placeholder:text-ink-faint md:text-sm',
        'transition-[border-color,box-shadow,background-color] duration-100 ease-out',
        'outline-none focus-visible:border-signal focus-visible:ring-[3px] focus-visible:ring-signal/25',
        'hover:not-focus:border-ink-faint/60',
        'disabled:cursor-not-allowed disabled:bg-surface-2 disabled:opacity-60',
        'file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-ink',
        'aria-invalid:border-danger aria-invalid:ring-[3px] aria-invalid:ring-danger/20',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
