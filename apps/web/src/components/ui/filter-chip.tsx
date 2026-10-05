import * as React from 'react';
import Link from 'next/link';
import { cn } from '@/lib/utils';

/**
 * A filter chip with a counter — "Operational 2". Active, it takes the soft
 * ultramarine: it is a selection, not a state. A button for a local filter, a
 * link for a filter carried by the URL.
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
    <Link
      aria-current={active ? 'page' : undefined}
      className={cn('chip', className)}
      scroll={false}
      {...props}
    >
      {children}
      {count !== undefined ? <span className="count num">{count}</span> : null}
    </Link>
  );
}

export { FilterChip, FilterChipLink };
