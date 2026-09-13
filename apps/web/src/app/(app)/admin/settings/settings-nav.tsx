'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useT } from '@/i18n/client';
import { settings as messages } from '@/i18n/messages/settings';
import { cn } from '@/lib/utils';
import { SETTINGS_OVERVIEW, SETTINGS_SECTIONS } from './sections';

/**
 * Rail des sous-sections.
 *
 * Des liens, pas des onglets : chaque section est une vraie page, adressable et
 * partageable. La section courante est donc désignée par `aria-current="page"`
 * — le motif ARIA d'onglets serait un mensonge, il promet un panneau qui
 * apparaît sans navigation.
 *
 * L'égalité stricte du chemin est volontaire : un `startsWith` rendrait
 * « Sommaire » actif sur toutes les sous-sections, puisque son href les
 * préfixe toutes.
 *
 * La grammaire visuelle est celle de `nav-link.tsx` — plot de signal à gauche,
 * fond `surface-2` quand c'est actif — pour que ce rail se lise comme une
 * subdivision du rail principal et non comme une pièce rapportée.
 */
export function SettingsNav() {
  const pathname = usePathname();
  const t = useT(messages);

  const entries = [
    { href: SETTINGS_OVERVIEW.href, label: t('section.overview.label'), icon: null },
    ...SETTINGS_SECTIONS.map((section) => ({
      href: section.href,
      label: t(`section.${section.id}.label`),
      icon: section.icon,
    })),
  ];

  return (
    <nav aria-label={t('nav.label')} className="lg:sticky lg:top-6">
      <ul
        className={cn(
          'flex gap-1 overflow-x-auto pb-2 [scrollbar-width:none]',
          'lg:flex-col lg:overflow-visible lg:pb-0',
        )}
      >
        {entries.map((entry) => {
          const active = pathname === entry.href;
          const Icon = entry.icon;
          return (
            <li key={entry.href} className="shrink-0 lg:shrink">
              <Link
                href={entry.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'group relative flex items-center gap-2.5 rounded-md py-1.5 pr-2.5 pl-3 text-sm',
                  'whitespace-nowrap transition-colors duration-100 ease-out',
                  'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                  active
                    ? 'bg-surface-2 font-medium text-ink'
                    : 'text-ink-muted hover:bg-surface-2/60 hover:text-ink',
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    'absolute top-1/2 left-0 w-[3px] -translate-y-1/2 rounded-full transition-all duration-200 ease-out',
                    active
                      ? 'h-4 bg-signal'
                      : 'h-0 bg-transparent group-hover:h-2 group-hover:bg-line-strong',
                  )}
                />
                {Icon ? (
                  <span
                    aria-hidden
                    className={cn(
                      'flex size-4 shrink-0 items-center justify-center transition-colors duration-100',
                      active ? 'text-signal' : 'text-ink-faint group-hover:text-ink-muted',
                    )}
                  >
                    <Icon className="size-4" />
                  </span>
                ) : (
                  <span aria-hidden className="size-4 shrink-0" />
                )}
                <span className="truncate">{entry.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
