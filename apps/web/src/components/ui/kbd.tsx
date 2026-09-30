import * as React from 'react';
import { cn } from '@/lib/utils';

/** Touche de clavier, en Geist Mono, avec son petit relief. */
export function Kbd({ className, ...props }: React.ComponentProps<'kbd'>) {
  return <kbd className={cn('kbd', className)} {...props} />;
}

/** Une combinaison : chaque touche dans sa case (⌘ K, G puis D…). */
export function Keys({ keys, className }: { keys: readonly string[]; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-0.5', className)}>
      {keys.map((key) => (
        <Kbd key={key}>{key}</Kbd>
      ))}
    </span>
  );
}
