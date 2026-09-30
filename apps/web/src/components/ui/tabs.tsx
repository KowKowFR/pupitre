import * as React from 'react';
import Link from 'next/link';
import { cn } from '@/lib/utils';

/**
 * Onglets soulignés : l'onglet courant prend un trait outremer de 2 px et
 * passe en semi-gras ; un compteur facultatif le suit. Deux formes, une seule
 * apparence : `Tab` pour un état local (`role="tab"`), `TabLink` pour un
 * onglet qui est une URL (`aria-current`), partageable et que le bouton
 * Précédent sait défaire.
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
