'use client';

import * as React from 'react';
import Link from 'next/link';
import { cn } from '@/lib/utils';

/**
 * Contrôle segmenté à boutons — une fenêtre de temps (24 h / 7 j), un mode
 * (Simple / Expert). Le segment actif est `aria-pressed` ; pour un choix de
 * formulaire, préférer `RadioGroup`, qui porte la valeur dans le champ.
 */
export function SegmentedControl<V extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: V;
  onChange: (value: V) => void;
  options: ReadonlyArray<{ value: V; label: React.ReactNode }>;
  label: string;
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cn('seg', className)}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** La même chose quand chaque segment est une URL (fenêtre en paramètre de requête). */
export function SegmentedLinks({
  options,
  label,
  className,
}: {
  options: ReadonlyArray<{ href: React.ComponentProps<typeof Link>['href']; label: React.ReactNode; active: boolean }>;
  label: string;
  className?: string;
}) {
  return (
    <nav aria-label={label} className={cn('seg', className)}>
      {options.map((option, index) => (
        <Link key={index} href={option.href} aria-current={option.active ? 'page' : undefined} scroll={false}>
          {option.label}
        </Link>
      ))}
    </nav>
  );
}
