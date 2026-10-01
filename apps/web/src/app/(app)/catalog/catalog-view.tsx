'use client';

import { useMemo, useState } from 'react';
import {
  BarChart3,
  Briefcase,
  Clapperboard,
  Code2,
  LayoutGrid,
  Newspaper,
  Radar,
  Search,
  ShieldCheck,
  Sparkles,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import type { CatalogCategory } from '@pupitre/core';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { useDrawerSelection } from '@/components/ui/drawer';
import { FilterChip } from '@/components/ui/filter-chip';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n/client';
import { catalog as messages } from '@/i18n/messages/catalog';
import type { ServiceRow } from '../applications/applications-view';
import { InstallDrawer } from './install-drawer';

export type TemplateView = {
  id: string;
  name: string;
  category: CatalogCategory;
  website: string;
  summary: string;
  firstRun: string;
  askedSecrets: string[];
  generatedSecrets: number;
  wantsHost: boolean;
  services: ServiceRow[];
  images: string[];
};

export const CATEGORY_ICON: Record<CatalogCategory, LucideIcon> = {
  monitoring: Radar,
  analytics: BarChart3,
  content: Newspaper,
  automation: Workflow,
  devtools: Code2,
  productivity: Briefcase,
  media: Clapperboard,
  security: ShieldCheck,
  demo: Sparkles,
};

/** Deux lettres du nom, sur un cartouche : « Uptime Kuma » → UK, « n8n » → N8. */
export function monogramOf(name: string): string {
  const words = name.split(/[\s.-]+/).filter(Boolean);
  const letters =
    words.length > 1 ? `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}` : name.slice(0, 2);
  return letters.toUpperCase();
}

export function Monogram({ name, size = 'md' }: { name: string; size?: 'md' | 'lg' }) {
  return (
    <span
      aria-hidden
      className={
        size === 'lg'
          ? 'grid size-10 shrink-0 place-items-center rounded-[10px] border border-border bg-surface-2 text-[14px] font-semibold text-text'
          : 'grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-surface-2 text-[13px] font-semibold text-text'
      }
    >
      {monogramOf(name)}
    </span>
  );
}

/**
 * La vitrine. Une recherche, les catégories, puis une carte par modèle ;
 * une carte ouvre son tiroir — ce qui va tourner, et l'installation.
 */
export function CatalogView({
  templates,
  categories,
  taken,
}: {
  templates: TemplateView[];
  categories: CatalogCategory[];
  taken: string[];
}) {
  const t = useT(messages);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<CatalogCategory | null>(null);

  const matching = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return templates.filter(
      (template) =>
        needle === '' ||
        template.name.toLowerCase().includes(needle) ||
        template.id.includes(needle) ||
        template.summary.toLowerCase().includes(needle) ||
        t(`category.${template.category}`).toLowerCase().includes(needle),
    );
  }, [templates, query, t]);
  const shown = category ? matching.filter((template) => template.category === category) : matching;
  const countOf = (value: CatalogCategory) =>
    matching.filter((template) => template.category === value).length;

  const drawer = useDrawerSelection(
    'template',
    shown.map((template) => template.id),
  );
  const selected = templates.find((template) => template.id === drawer.selected) ?? null;

  return (
    <>
      <PageHeader title={t('page.title')} description={t('page.description')} />

      <div className="flex flex-col gap-3">
        <label className="affix max-w-md">
          <Search aria-hidden />
          <Input
            type="search"
            aria-label={t('search.label')}
            placeholder={t('search.placeholder')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('page.title')}>
          <FilterChip
            active={category === null}
            count={matching.length}
            onClick={() => setCategory(null)}
          >
            {t('category.all')}
          </FilterChip>
          {categories.map((value) =>
            countOf(value) > 0 || category === value ? (
              <FilterChip
                key={value}
                active={category === value}
                count={countOf(value)}
                onClick={() => setCategory(category === value ? null : value)}
              >
                {t(`category.${value}`)}
              </FilterChip>
            ) : null,
          )}
        </div>
      </div>

      {shown.length === 0 ? (
        <EmptyState icon={LayoutGrid} title={t('empty.title')} hint={t('empty.hint')} />
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {shown.map((template) => {
            const Icon = CATEGORY_ICON[template.category];
            return (
              <li key={template.id} className="flex">
                <button
                  type="button"
                  onClick={() => drawer.open(template.id)}
                  aria-current={drawer.selected === template.id ? 'true' : undefined}
                  className="card flex w-full flex-col gap-3 p-4 text-left transition-colors hover:border-hover-line focus-visible:shadow-focus focus-visible:outline-none aria-[current]:border-accent-line"
                >
                  <span className="flex items-center gap-3">
                    <Monogram name={template.name} />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-semibold text-text">{template.name}</span>
                      <span className="t-cap flex items-center gap-1 text-text-3">
                        <Icon aria-hidden className="size-3" />
                        {t(`category.${template.category}`)}
                      </span>
                    </span>
                  </span>
                  <span className="t-sm line-clamp-3 text-text-2">{template.summary}</span>
                  <span className="t-cap mt-auto flex min-w-0 items-center gap-x-2 text-text-3">
                    <span className="shrink-0">
                      {t('card.services', { count: template.services.length })}
                    </span>
                    <span aria-hidden>·</span>
                    <span className="mono min-w-0 truncate">{template.images[0]}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <InstallDrawer
        template={selected}
        taken={taken}
        onClose={drawer.close}
        onPrevious={drawer.onPrevious}
        onNext={drawer.onNext}
      />
    </>
  );
}
