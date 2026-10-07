import type { Route } from 'next';
import Link from 'next/link';
import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { getT } from '@/i18n/server';
import { docs as messages } from '@/i18n/messages/docs';
import { DOC_GROUPS } from '@/lib/docs/chapters';
import type { DocChapterSummary } from '@/lib/docs/content';
import type { DocHeading } from '@/lib/docs/markdown';

/**
 * The documentation's left column: the search, then the chapters by group. A
 * plain GET form — the search runs on the server, over every chapter, and its
 * results are a page one can link to.
 */
export async function DocsNav({
  chapters,
  active,
  query = '',
}: {
  chapters: readonly DocChapterSummary[];
  active: string | null;
  query?: string;
}) {
  const t = await getT(messages);
  return (
    <nav className="doc-nav" aria-label={t('nav.landmark')}>
      <form action="/docs" method="get" role="search" className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-text-3"
        />
        <Input
          type="search"
          name="q"
          defaultValue={query}
          aria-label={t('search.label')}
          placeholder={t('search.placeholder')}
          className="input-sm pl-8"
        />
      </form>
      {DOC_GROUPS.map((group) => (
        <div key={group} className="doc-nav-group">
          <span className="doc-nav-label">{t(`group.${group}`)}</span>
          {chapters
            .filter((chapter) => chapter.group === group)
            .map((chapter) => (
              <Link
                key={chapter.slug}
                href={`/docs/${chapter.slug}` as Route}
                aria-current={chapter.slug === active ? 'page' : undefined}
              >
                {chapter.title}
              </Link>
            ))}
        </div>
      ))}
    </nav>
  );
}

/** The right column: the chapter's sections. */
export async function DocsToc({ headings }: { headings: readonly DocHeading[] }) {
  const t = await getT(messages);
  if (headings.length === 0) return <aside className="doc-toc" />;
  return (
    <aside className="doc-toc" aria-label={t('toc.title')}>
      <span className="doc-toc-title">{t('toc.title')}</span>
      {headings.map((heading) => (
        <a key={heading.id} href={`#${heading.id}`} data-level={heading.level}>
          {heading.text}
        </a>
      ))}
    </aside>
  );
}
