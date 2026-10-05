import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A dressed native `<select>`: the same template as `Input`, chevron as a
 * data-URI. The native one is enough here — keyboard, screen readers and mobile
 * picker are the system's.
 */
function Select({ className, ...props }: React.ComponentProps<'select'>) {
  return <select data-slot="select" className={cn('select', className)} {...props} />;
}

export { Select };
