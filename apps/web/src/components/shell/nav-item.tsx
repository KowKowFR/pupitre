'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Led } from '@/components/ui/led';
import { activeSection, type SectionKey } from '@/lib/navigation';
import { cn } from '@/lib/utils';
import { SECTION_ICON } from './section-icons';

export type NavMeta =
  | { kind: 'count'; value: number; alert?: boolean; label?: string }
  | { kind: 'inflight'; label: string };

/**
 * Entrée de rail — 32 px. Active : fond de surface, ombre `sm`, icône en
 * outremer. À droite, une méta : un compteur (rouge pour une anomalie), ou un
 * voyant qui pulse tant qu'un déploiement est en vol.
 */
export function NavItem({
  section,
  href,
  label,
  meta,
  compact = false,
}: {
  section: SectionKey;
  href: string;
  label: string;
  meta?: NavMeta;
  compact?: boolean;
}) {
  const pathname = usePathname();
  const active = activeSection(pathname) === section;
  const Icon = SECTION_ICON[section];

  return (
    <Link
      href={href as never}
      aria-current={active ? 'page' : undefined}
      className={cn('nav-item', compact && 'shrink-0')}
    >
      <Icon aria-hidden />
      <span className="truncate">{label}</span>
      {meta && !compact ? (
        meta.kind === 'count' ? (
          <>
            <span
              className={cn('meta', meta.alert && 'is-alert')}
              aria-hidden={meta.label ? true : undefined}
            >
              {meta.value}
            </span>
            {meta.label ? <span className="sr-only">{meta.label}</span> : null}
          </>
        ) : (
          <span className="meta">
            <Led tone="accent" pulse label={meta.label} />
          </span>
        )
      ) : null}
    </Link>
  );
}
