'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Entrée de rail. L'état actif est porté par un plot de signal à gauche —
 * la même grammaire qu'un voyant de port sur un panneau de brassage — et non
 * par un simple fond coloré : on repère la section active du coin de l'œil.
 */
export function NavLink({
  href,
  icon,
  children,
}: {
  href: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const active = href === '/' ? pathname === '/' : pathname.startsWith(href);

  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group relative flex items-center gap-2.5 rounded-md py-1.5 pr-2.5 pl-3 text-sm',
        'transition-colors duration-100 ease-out',
        active ? 'bg-surface-2 font-medium text-ink' : 'text-ink-muted hover:bg-surface-2/60 hover:text-ink',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'absolute top-1/2 left-0 w-[3px] -translate-y-1/2 rounded-full transition-all duration-200 ease-out',
          active ? 'h-4 bg-signal' : 'h-0 bg-transparent group-hover:h-2 group-hover:bg-line-strong',
        )}
      />
      {icon ? (
        <span
          aria-hidden
          className={cn(
            'flex size-4 shrink-0 items-center justify-center transition-colors duration-100',
            active ? 'text-signal' : 'text-ink-faint group-hover:text-ink-muted',
          )}
        >
          {icon}
        </span>
      ) : null}
      <span className="truncate">{children}</span>
    </Link>
  );
}
