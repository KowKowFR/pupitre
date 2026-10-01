import Link from 'next/link';
import { Search } from 'lucide-react';
import { Progress } from '@/components/ui/data';
import { Kbd } from '@/components/ui/kbd';
import { getT } from '@/i18n/server';
import { chrome } from '@/i18n/messages/chrome';
import type { NavGroup } from '@/lib/navigation';
import type { ThemeChoice } from '@/lib/theme';
import { InstanceMenu } from './instance-menu';
import { NavItem, type NavMeta } from './nav-item';
import { PaletteTrigger } from './shell-provider';
import { UserMenu } from './user-menu';

export type RailOnboarding = { done: number; total: number; next: string } | null;

/**
 * Le rail — 240 px sur `bg-subtle`. En tête, l'instance et la recherche ⌘K ;
 * puis « Exploitation » et « Administration », chacun réduit à ce que la
 * session peut ouvrir ; en pied, la carte de démarrage tant que l'assistant
 * n'est pas tranché, et l'utilisateur.
 */
export async function Rail({
  instance,
  groups,
  metas,
  onboarding,
  user,
  canOpenSettings,
}: {
  instance: { name: string; tagline: string };
  groups: NavGroup[];
  metas: Partial<Record<string, NavMeta>>;
  onboarding: RailOnboarding;
  user: {
    name: string;
    email: string;
    image: string | null;
    roleLabel: string;
    theme: ThemeChoice;
  };
  canOpenSettings: boolean;
}) {
  const t = await getT(chrome);

  return (
    <div className="side-wrap max-lg:hidden">
      <nav className="side" aria-label={t('nav.landmark')}>
        <InstanceMenu
          name={instance.name}
          tagline={instance.tagline}
          canOpenSettings={canOpenSettings}
        />
        <PaletteTrigger className="side-search">
          <Search aria-hidden className="!size-3.5" />
          <span className="truncate">{t('palette.open')}</span>
          <span className="ml-auto flex items-center gap-0.5">
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </span>
        </PaletteTrigger>

        {groups.map((group) => (
          <div key={group.key} className="nav-group">
            <span className="nav-label">{t(`nav.group.${group.key}`)}</span>
            {group.sections.map((section) => (
              <NavItem
                key={section.key}
                section={section.key}
                href={section.href}
                label={t(`nav.${section.key}`)}
                meta={metas[section.key]}
              />
            ))}
          </div>
        ))}

        <div className="side-foot">
          {onboarding ? (
            <Link
              href="/onboarding"
              className="flex flex-col gap-2 rounded-[10px] border border-border bg-surface px-2.5 pt-2.5 pb-[11px] text-text no-underline transition-colors hover:border-border-strong"
            >
              <span className="t-cap flex items-center gap-2">
                <span className="font-semibold">{t('shell.onboarding.title')}</span>
                <span className="num ml-auto text-text-3">
                  {t('shell.onboarding.count', { done: onboarding.done, total: onboarding.total })}
                </span>
              </span>
              <Progress
                value={onboarding.total === 0 ? 0 : (onboarding.done / onboarding.total) * 100}
                label={t('shell.onboarding.title')}
                height={4}
              />
              <span className="t-cap text-text-3">
                {t('shell.onboarding.next', { step: onboarding.next })}
              </span>
            </Link>
          ) : null}
          <UserMenu {...user} />
        </div>
      </nav>
    </div>
  );
}
