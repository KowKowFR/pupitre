'use client';

import * as React from 'react';
import Link from 'next/link';
import { cn } from '@/lib/utils';

/**
 * A segmented control with buttons — a time window (24 h / 7 d), a mode (Simple /
 * Expert). The active segment is `aria-pressed`; for a form choice, prefer
 * `RadioGroup`, which carries the value in the field.
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

/** The same thing when each segment is a URL (window as a query parameter). */
export function SegmentedLinks({
  options,
  label,
  className,
}: {
  options: ReadonlyArray<{
    href: React.ComponentProps<typeof Link>['href'];
    label: React.ReactNode;
    active: boolean;
  }>;
  label: string;
  className?: string;
}) {
  return (
    <nav aria-label={label} className={cn('seg', className)}>
      {options.map((option, index) => (
        <Link
          key={index}
          href={option.href}
          aria-current={option.active ? 'page' : undefined}
          scroll={false}
        >
          {option.label}
        </Link>
      ))}
    </nav>
  );
}
