'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronRight, CircleHelp, Keyboard, Search } from 'lucide-react';
import { BrandMark } from '@/components/brand-mark';
import { Led } from '@/components/ui/led';
import { IconButton, Tooltip } from '@/components/ui/tooltip';
import { useT } from '@/i18n/client';
import { chrome } from '@/i18n/messages/chrome';
import { DOCS_URL } from '@/lib/links';
import { activeSection } from '@/lib/navigation';
import type { ThemeChoice } from '@/lib/theme';
import { useCrumb } from './breadcrumb';
import { NavItem, type NavMeta } from './nav-item';
import type { ShellSection } from './shell-provider';
import { useShell } from './shell-provider';
import { UserMenu } from './user-menu';

export type WorkerPill =
  { state: 'active'; idleSeconds: number } | { state: 'idle' } | { state: 'unknown' };

/**
 * Barre haute — 52 px. À gauche, le fil d'Ariane : l'instance, la section,
 * l'objet. Il remplace les surtitres. À droite, l'état du worker, la
 * documentation et les raccourcis.
 */
export function Topbar({
  instanceName,
  sections,
  worker,
}: {
  instanceName: string;
  sections: ShellSection[];
  worker: WorkerPill;
}) {
  const t = useT(chrome);
  const pathname = usePathname();
  const crumb = useCrumb();
  const { openShortcuts } = useShell();
  const sectionKey = activeSection(pathname);
  const section = sections.find((candidate) => candidate.key === sectionKey);
  const onSectionRoot = section !== undefined && pathname === section.href;

  return (
    <header className="top max-lg:hidden">
      <nav aria-label={t('shell.breadcrumb')} className="crumbs">
        <Link href="/">{instanceName}</Link>
        {section ? (
          <>
            <ChevronRight aria-hidden />
            {onSectionRoot && !crumb ? (
              <span className="cur" aria-current="page">
                {t(`nav.${section.key}`)}
              </span>
            ) : (
              <Link href={section.href as never}>{t(`nav.${section.key}`)}</Link>
            )}
          </>
        ) : null}
        {crumb ? (
          <>
            <ChevronRight aria-hidden />
            <span className="cur" aria-current="page">
              {crumb}
            </span>
          </>
        ) : null}
      </nav>
      <div className="ml-auto flex items-center gap-2">
        <WorkerStatusPill worker={worker} />
        <IconButton label={t('shell.docs')} asChild>
          <a href={DOCS_URL} target="_blank" rel="noreferrer">
            <CircleHelp />
          </a>
        </IconButton>
        <IconButton label={t('shell.shortcuts')} kbd="?" onClick={openShortcuts}>
          <Keyboard />
        </IconButton>
      </div>
    </header>
  );
}

function WorkerStatusPill({ worker }: { worker: WorkerPill }) {
  const t = useT(chrome);
  const label =
    worker.state === 'active'
      ? t('shell.worker.active')
      : worker.state === 'idle'
        ? t('shell.worker.idle')
        : t('shell.worker.unknown');
  const tip =
    worker.state === 'active'
      ? t('shell.worker.tip.active', { ago: `${worker.idleSeconds} s` })
      : worker.state === 'idle'
        ? t('shell.worker.tip.idle', { ago: '—' })
        : t('shell.worker.tip.unknown');
  return (
    <Tooltip content={tip} side="bottom">
      <span
        tabIndex={0}
        className="t-cap inline-flex h-7 items-center gap-2 rounded-full border border-border bg-surface px-2.5 text-text-2"
      >
        <Led
          tone={worker.state === 'active' ? 'ok' : worker.state === 'idle' ? 'danger' : 'idle'}
        />
        {label}
      </span>
    </Tooltip>
  );
}

/**
 * Sous `lg` : barre haute collante et floutée, avec la tuile, la recherche et
 * le compte, puis la navigation à plat qui défile horizontalement.
 */
export function MobileHeader({
  instanceName,
  sections,
  metas,
  user,
}: {
  instanceName: string;
  sections: Array<ShellSection & { label: string }>;
  metas: Partial<Record<string, NavMeta>>;
  user: { name: string; email: string; roleLabel: string; theme: ThemeChoice };
}) {
  const t = useT(chrome);
  const { openPalette } = useShell();
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-bg/85 backdrop-blur-md lg:hidden">
      <div className="flex h-14 items-center gap-2.5 px-4">
        <Link href="/" className="flex min-w-0 items-center gap-2.5">
          <BrandMark size={26} />
          <span className="truncate text-[14px] font-semibold">{instanceName}</span>
        </Link>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label={t('palette.open')}
            onClick={() => openPalette()}
          >
            <Search aria-hidden />
          </button>
          <UserMenu {...user} variant="icon" />
        </div>
      </div>
      <nav
        aria-label={t('nav.landmark')}
        className="flex gap-1 overflow-x-auto px-3 pb-2 [scrollbar-width:none]"
      >
        {sections.map((section) => (
          <NavItem
            key={section.key}
            section={section.key}
            href={section.href}
            label={section.label}
            meta={metas[section.key]}
            compact
          />
        ))}
      </nav>
    </header>
  );
}
