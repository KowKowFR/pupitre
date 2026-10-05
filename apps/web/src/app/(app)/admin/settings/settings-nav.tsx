'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useT } from '@/i18n/client';
import { settings as messages } from '@/i18n/messages/settings';
import { SETTINGS_GROUPS, groupSections, settingsGroupOf } from './sections';

/**
 * The groups' rail: four entries, not ten.
 *
 * Links, not tabs: each section is a real page, addressable and shareable. A
 * group leads to its first tab; it is marked current (`aria-current="page"`)
 * when the displayed page is one of its sections.
 *
 * The entries reuse the main rail's `.nav-item` class: this rail reads as a
 * subdivision of that one, not as an added piece.
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
 * The current group's tabs: its sections, each one an address. Always links —
 * the ARIA tabs pattern would promise a panel that appears without navigation,
 * which is not the case.
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
