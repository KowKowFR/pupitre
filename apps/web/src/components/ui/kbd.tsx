import * as React from 'react';
import { cn } from '@/lib/utils';

/** A keyboard key, in Geist Mono, with its slight relief. */
export function Kbd({ className, ...props }: React.ComponentProps<'kbd'>) {
  return <kbd className={cn('kbd', className)} {...props} />;
}

/** A combination: each key in its cell (⌘ K, G then D…). */
export function Keys({ keys, className }: { keys: readonly string[]; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-0.5', className)}>
      {keys.map((key) => (
        <Kbd key={key}>{key}</Kbd>
      ))}
    </span>
  );
}
