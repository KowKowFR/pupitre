'use client';

import Link from 'next/link';
import { ArrowUpRight, BookOpen, ChevronsUpDown, Gauge, SlidersHorizontal } from 'lucide-react';
import { BrandMark } from '@/components/brand-mark';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useT } from '@/i18n/client';
import { chrome } from '@/i18n/messages/chrome';
import { DOCS_URL } from '@/lib/links';

/**
 * Le bloc d'instance en tête du rail : la tuile, le nom et le sous-titre de
 * l'instance, et un chevron vers son menu. Les paramètres n'y figurent que si
 * la session peut les ouvrir.
 */
export function InstanceMenu({
  name,
  tagline,
  canOpenSettings,
}: {
  name: string;
  tagline: string;
  canOpenSettings: boolean;
}) {
  const t = useT(chrome);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="side-brand" aria-label={t('shell.instanceMenu', { name })}>
          <BrandMark size={28} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[14px] leading-[18px] font-semibold">{name}</span>
            {tagline ? <span className="t-cap truncate text-text-3">{tagline}</span> : null}
          </span>
          <ChevronsUpDown aria-hidden className="!size-3.5 text-text-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-[240px]">
        <DropdownMenuItem asChild>
          <Link href="/">
            <Gauge aria-hidden />
            {t('nav.dashboard')}
          </Link>
        </DropdownMenuItem>
        {canOpenSettings ? (
          <DropdownMenuItem asChild>
            <Link href="/admin/settings">
              <SlidersHorizontal aria-hidden />
              {t('shell.instance.settings')}
            </Link>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <a href={DOCS_URL} target="_blank" rel="noreferrer">
            <BookOpen aria-hidden />
            {t('shell.docs')}
            <ArrowUpRight aria-hidden className="ml-auto" />
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
