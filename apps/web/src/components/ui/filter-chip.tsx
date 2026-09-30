import * as React from 'react';
import Link from 'next/link';
import { cn } from '@/lib/utils';

/**
 * Puce de filtre avec compteur — « Opérationnelles 2 ». Active, elle prend
 * l'outremer doux : c'est une sélection, pas un état. Bouton pour un filtre
 * local, lien pour un filtre porté par l'URL.
 */
function FilterChip({
  active,
  count,
  className,
  children,
  ...props
}: React.ComponentProps<'button'> & { active: boolean; count?: React.ReactNode }) {
  return (
    <button type="button" aria-pressed={active} className={cn('chip', className)} {...props}>
      {children}
      {count !== undefined ? <span className="count num">{count}</span> : null}
    </button>
  );
}

function FilterChipLink({
  active,
  count,
  className,
  children,
  ...props
}: React.ComponentProps<typeof Link> & { active: boolean; count?: React.ReactNode }) {
  return (
    <Link aria-current={active ? 'page' : undefined} className={cn('chip', className)} scroll={false} {...props}>
      {children}
      {count !== undefined ? <span className="count num">{count}</span> : null}
    </Link>
  );
}

export { FilterChip, FilterChipLink };
