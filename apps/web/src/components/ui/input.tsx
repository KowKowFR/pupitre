import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * An input field — 34 px, ultramarine focus with a 3 px ring, `aria-invalid` state
 * in red. The identifiers (host, slug, image) take the `mono` class.
 */
function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return <input type={type} data-slot="input" className={cn('input', className)} {...props} />;
}

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return <textarea data-slot="textarea" className={cn('textarea', className)} {...props} />;
}

export { Input, Textarea };
