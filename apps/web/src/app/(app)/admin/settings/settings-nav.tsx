'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useT } from '@/i18n/client';
import { settings as messages } from '@/i18n/messages/settings';
import { SETTINGS_GROUPS, groupSections, settingsGroupOf } from './sections';

/**
 * Rail des groupes : quatre entrées, pas dix.
 *
 * Des liens, pas des onglets : chaque section est une vraie page, adressable et
 * partageable. Un groupe mène à son premier onglet ; il est marqué courant
 * (`aria-current="page"`) quand la page affichée est l'une de ses sections.
 *
 * Les entrées reprennent la classe `.nav-item` du rail principal : ce rail se
 * lit comme une subdivision de celui-là, pas comme une pièce rapportée.
 */
export function SettingsNav() {
  const pathname = usePathname();
  const t = useT(messages);
  const current = settingsGroupOf(pathname);

  return (
    <nav aria-label={t('nav.label')} className="lg:sticky lg:top-20 lg:self-start">
      <ul className="flex gap-1 overflow-x-auto pb-2 [scrollbar-width:none] lg:flex-col lg:gap-px lg:overflow-visible lg:pb-0">
        {SETTINGS_GROUPS.map((group) => {
          const Icon = group.icon;
          const first = groupSections(group)[0];
          if (!first) return null;
          return (
            <li key={group.id} className="shrink-0 lg:shrink">
              <Link
                href={first.href as never}
                aria-current={current?.id === group.id ? 'page' : undefined}
                className="nav-item whitespace-nowrap"
              >
                <Icon aria-hidden />
                <span className="truncate">{t(`group.${group.id}.label`)}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * Les onglets du groupe courant : ses sections, chacune une adresse. Toujours
 * des liens — le motif ARIA d'onglets promettrait un panneau qui apparaît sans
 * navigation, ce qui n'est pas le cas.
 */
export function SettingsTabs() {
  const pathname = usePathname();
  const t = useT(messages);
  const group = settingsGroupOf(pathname);
  if (!group) return null;

  return (
    <nav aria-label={t(`group.${group.id}.label`)} className="tabs">
      {groupSections(group).map((section) => (
        <Link
          key={section.id}
          href={section.href as never}
          aria-current={pathname === section.href ? 'page' : undefined}
          className="tab whitespace-nowrap"
        >
          {t(`section.${section.id}.label`)}
        </Link>
      ))}
    </nav>
  );
}
