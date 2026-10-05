'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowUpRight, BookOpen, Ellipsis, Keyboard, LogOut, ShieldCheck } from 'lucide-react';
import { Avatar } from '@/components/ui/data';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Kbd } from '@/components/ui/kbd';
import { PresenceDot } from '@/components/realtime/presence';
import { useOptionalRealtime } from '@/components/realtime/realtime-provider';
import { StatusSubMenu } from '@/components/realtime/status-menu';
import { useT } from '@/i18n/client';
import { chrome } from '@/i18n/messages/chrome';
import { DOCS_URL } from '@/lib/links';
import { applyTheme, THEME_CHOICES, type ThemeChoice } from '@/lib/theme';
import { useShell } from './shell-provider';

/**
 * The user block at the bottom of the rail and its menu: My account, Theme,
 * Shortcuts, Documentation, then sign-out, alone in red, last.
 *
 * The theme is set here, in three segments. The current choice is given by the
 * server (the cookie it read to paint the page): no flicker of the control at
 * hydration.
 */
export function UserMenu({
  name,
  email,
  image,
  roleLabel,
  theme: initialTheme,
  variant = 'rail',
}: {
  name: string;
  email: string;
  image: string | null;
  roleLabel: string;
  theme: ThemeChoice;
  variant?: 'rail' | 'icon';
}) {
  const t = useT(chrome);
  const { openShortcuts } = useShell();
  const [theme, setTheme] = React.useState<ThemeChoice>(initialTheme);
  const realtime = useOptionalRealtime();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {variant === 'rail' ? (
          <button type="button" className="side-user" aria-label={t('shell.userMenu')}>
            <span className="presence">
              <Avatar name={name} src={image} />
              {realtime ? <PresenceDot status={realtime.statusOf(realtime.me)} /> : null}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="t-sm truncate leading-[18px] font-semibold">{name}</span>
              <span className="t-cap truncate text-text-3">{roleLabel}</span>
            </span>
            <Ellipsis aria-hidden className="text-text-3" />
          </button>
        ) : (
          <button type="button" className="btn btn-ghost btn-icon" aria-label={t('shell.userMenu')}>
            <ShieldCheck aria-hidden />
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side={variant === 'rail' ? 'top' : 'bottom'}
        align={variant === 'rail' ? 'start' : 'end'}
        className="w-[240px]"
      >
        <div className="-mx-1 -mt-1 mb-1 flex items-center gap-2.5 border-b border-border-subtle px-3 py-2.5">
          <Avatar name={name} src={image} />
          <span className="flex min-w-0 flex-col">
            <span className="t-sm truncate font-semibold">{name}</span>
            <span className="t-cap truncate text-text-3">{email}</span>
          </span>
        </div>
        <StatusSubMenu />
        <DropdownMenuItem asChild>
          <Link href="/account">
            <ShieldCheck aria-hidden />
            {t('nav.account')}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuLabel>{t('shell.theme')}</DropdownMenuLabel>
        <div className="px-1.5 pb-1.5">
          <div role="group" aria-label={t('shell.theme')} className="seg w-full">
            {THEME_CHOICES.map((choice) => (
              <button
                key={choice}
                type="button"
                className="flex-1"
                aria-pressed={theme === choice}
                onClick={() => {
                  applyTheme(choice);
                  setTheme(choice);
                }}
              >
                {t(`shell.theme.${choice}`)}
              </button>
            ))}
          </div>
        </div>
        <DropdownMenuItem onSelect={openShortcuts} meta={<Kbd>?</Kbd>}>
          <Keyboard aria-hidden />
          {t('shell.shortcuts')}
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={DOCS_URL} target="_blank" rel="noreferrer">
            <BookOpen aria-hidden />
            {t('shell.docs')}
            <ArrowUpRight aria-hidden className="ml-auto" />
          </a>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild destructive>
          <Link href="/logout">
            <LogOut aria-hidden />
            {t('nav.signOut')}
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
