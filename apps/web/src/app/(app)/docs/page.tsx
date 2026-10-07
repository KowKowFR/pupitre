import type { Metadata, Route } from 'next';
import Link from 'next/link';
import { DocsNav } from '@/components/docs/docs-nav';
import { PageHeader } from '@/components/page-header';
import { docs as messages } from '@/i18n/messages/docs';
import { currentLanguage, getT } from '@/i18n/server';
import { DOC_GROUPS } from '@/lib/docs/chapters';
import { listChapters, searchDocs } from '@/lib/docs/content';
import { requirePageSession } from '@/lib/page-auth';
import { panelOrigin } from '@/lib/sources';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT(messages))('page.title') };
}

export const dynamic = 'force-dynamic';

/**
 * The documentation's home: every chapter, by group — or, with `?q=`, the
 * sections that match, across every chapter.
 *
 * Any session reads it: it describes screens some roles cannot open, and says
 * so; the screens stay guarded by their own permission.
 */
export default async function DocsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePageSession('/docs');
  const [t, language, params] = await Promise.all([getT(messages), currentLanguage(), searchParams]);
  const origin = panelOrigin();
  const query = typeof params.q === 'string' ? params.q.trim().slice(0, 200) : '';
  const chapters = listChapters(language, origin);
  const hits = query ? searchDocs(language, query, origin) : null;

  return (
    <div className="page">
      <PageHeader title={t('page.title')} description={t('page.description')} />
      <div className="doc-layout" data-toc="none">
        <DocsNav chapters={chapters} active={null} query={query} />
        <div className="flex min-w-0 flex-col gap-6">
          {hits ? (
            <section className="flex flex-col gap-3" aria-live="polite">
              <div className="flex flex-wrap items-baseline gap-3">
                <h2 className="t-title">
                  {hits.length === 0
                    ? t('search.none', { query })
                    : t('search.results', { count: hits.length, query })}
                </h2>
                <Link href="/docs" className="link t-sm">
                  {t('search.clear')}
                </Link>
              </div>
              <ul className="flex flex-col gap-2">
                {hits.map((hit) => (
                  <li key={`${hit.slug}#${hit.section?.id ?? ''}`}>
                    <Link
                      href={`/docs/${hit.slug}${hit.section ? `#${hit.section.id}` : ''}` as Route}
                      className="well flex flex-col gap-1 no-underline hover:border-border-strong"
                    >
                      <span className="t-h text-text">
                        {hit.chapter}
                        {hit.section ? <span className="text-text-3"> › {hit.section.text}</span> : null}
                      </span>
                      <span className="t-sm text-text-2">{hit.excerpt}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : (
            DOC_GROUPS.map((group) => (
              <section key={group} className="flex flex-col gap-3">
                <h2 className="t-title">{t(`group.${group}`)}</h2>
                <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  {chapters
                    .filter((chapter) => chapter.group === group)
                    .map((chapter) => (
                      <li key={chapter.slug}>
                        <Link
                          href={`/docs/${chapter.slug}` as Route}
                          className="well flex h-full flex-col gap-1 no-underline hover:border-border-strong"
                        >
                          <span className="t-h text-text">{chapter.title}</span>
                          <span className="t-sm text-text-2">{chapter.summary}</span>
                        </Link>
                      </li>
                    ))}
                </ul>
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
