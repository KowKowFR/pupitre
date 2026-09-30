import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Champ de saisie — 34 px, focus outremer avec anneau de 3 px, état
 * `aria-invalid` en rouge. Les identifiants (hôte, slug, image) prennent la
 * classe `mono`.
 */
function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return <input type={type} data-slot="input" className={cn('input', className)} {...props} />;
}

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return <textarea data-slot="textarea" className={cn('textarea', className)} {...props} />;
}

export { Input, Textarea };
