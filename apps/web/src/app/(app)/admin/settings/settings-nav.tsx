'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useT } from '@/i18n/client';
import { settings as messages } from '@/i18n/messages/settings';
import { LayoutGrid } from 'lucide-react';
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
 * Les entrées reprennent la classe `.nav-item` du rail principal : ce rail se
 * lit comme une subdivision de celui-là, pas comme une pièce rapportée.
 */
export function SettingsNav() {
  const pathname = usePathname();
  const t = useT(messages);

  const entries = [
    { href: SETTINGS_OVERVIEW.href, label: t('section.overview.label'), icon: LayoutGrid },
    ...SETTINGS_SECTIONS.map((section) => ({
      href: section.href,
      label: t(`section.${section.id}.label`),
      icon: section.icon,
    })),
  ];

  return (
    <nav aria-label={t('nav.label')} className="lg:sticky lg:top-20 lg:self-start">
      <ul className="flex gap-1 overflow-x-auto pb-2 [scrollbar-width:none] lg:flex-col lg:gap-px lg:overflow-visible lg:pb-0">
        {entries.map((entry) => {
          const Icon = entry.icon;
          return (
            <li key={entry.href} className="shrink-0 lg:shrink">
              <Link
                href={entry.href}
                aria-current={pathname === entry.href ? 'page' : undefined}
                className="nav-item whitespace-nowrap"
              >
                <Icon aria-hidden />
                <span className="truncate">{entry.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
