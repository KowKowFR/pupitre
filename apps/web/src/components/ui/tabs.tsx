import * as React from 'react';
import Link from 'next/link';
import { cn } from '@/lib/utils';

/**
 * Underlined tabs: the current tab takes a 2 px ultramarine line and goes
 * semi-bold; an optional counter follows it. Two shapes, a single appearance:
 * `Tab` for a local state (`role="tab"`), `TabLink` for a tab that is a URL
 * (`aria-current`), shareable and undoable with the Back button.
 */
function Tabs({
  className,
  label,
  asNav = false,
  ...props
}: React.ComponentProps<'div'> & { label: string; asNav?: boolean }) {
  if (asNav) {
    return <nav aria-label={label} className={cn('tabs', className)} {...props} />;
  }
  return <div role="tablist" aria-label={label} className={cn('tabs', className)} {...props} />;
}

function Count({ value }: { value?: React.ReactNode }) {
  if (value === undefined || value === null) return null;
  return <span className="count num">{value}</span>;
}

function Tab({
  selected,
  count,
  className,
  children,
  ...props
}: React.ComponentProps<'button'> & { selected: boolean; count?: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      className={cn('tab', className)}
      {...props}
    >
      {children}
      <Count value={count} />
    </button>
  );
}

function TabLink({
  selected,
  count,
  className,
  children,
  ...props
}: React.ComponentProps<typeof Link> & { selected: boolean; count?: React.ReactNode }) {
  return (
    <Link aria-current={selected ? 'page' : undefined} className={cn('tab', className)} {...props}>
      {children}
      <Count value={count} />
    </Link>
  );
}

export { Tabs, Tab, TabLink };
