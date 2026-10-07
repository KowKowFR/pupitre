import type { Metadata, Route } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { DocsNav, DocsToc } from '@/components/docs/docs-nav';
import { MarkdownView } from '@/components/docs/markdown-view';
import { docs as messages } from '@/i18n/messages/docs';
import { currentLanguage, getT } from '@/i18n/server';
import { isDocSlug, neighbors } from '@/lib/docs/chapters';
import { listChapters, readChapter } from '@/lib/docs/content';
import { requirePageSession } from '@/lib/page-auth';
import { panelOrigin } from '@/lib/sources';

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  if (!isDocSlug(slug)) return {};
  const chapter = readChapter(await currentLanguage(), slug, panelOrigin());
  return { title: chapter.title, description: chapter.summary };
}

export const dynamic = 'force-dynamic';

/** A chapter: the chapters on the left, the text, its sections on the right. */
export default async function DocChapterPage({ params }: Props) {
  const { slug } = await params;
  if (!isDocSlug(slug)) notFound();
  await requirePageSession(`/docs/${slug}`);

  const [t, language] = await Promise.all([getT(messages), currentLanguage()]);
  const origin = panelOrigin();
  const chapter = readChapter(language, slug, origin);
  const chapters = listChapters(language, origin);
  const { previous, next } = neighbors(slug);
  const titleOf = (target: string) => chapters.find((candidate) => candidate.slug === target)?.title ?? target;

  return (
    <div className="page">
      <div className="doc-layout">
        <DocsNav chapters={chapters} active={slug} />
        <div className="min-w-0">
          <MarkdownView blocks={chapter.blocks} />
          <nav className="doc-pager" aria-label={t('nav.landmark')}>
            {previous ? (
              <Link href={`/docs/${previous.slug}` as Route} data-dir="previous">
                <span className="t-cap inline-flex items-center gap-1 text-text-3">
                  <ArrowLeft aria-hidden className="size-3" />
                  {t('chapter.previous')}
                </span>
                <span className="t-h">{titleOf(previous.slug)}</span>
              </Link>
            ) : null}
            {next ? (
              <Link href={`/docs/${next.slug}` as Route} data-dir="next">
                <span className="t-cap inline-flex items-center justify-end gap-1 text-text-3">
                  {t('chapter.next')}
                  <ArrowRight aria-hidden className="size-3" />
                </span>
                <span className="t-h">{titleOf(next.slug)}</span>
              </Link>
            ) : null}
          </nav>
        </div>
        <DocsToc headings={chapter.headings} />
      </div>
    </div>
  );
}
