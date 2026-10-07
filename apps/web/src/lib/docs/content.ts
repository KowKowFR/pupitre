import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { UiLanguage } from '@pupitre/core';
import { DOC_CHAPTERS, isDocSlug, type DocGroup } from './chapters';
import { blockText, headingsOf, parseMarkdown, plainText, type Block, type DocHeading } from './markdown';

/**
 * Reading the chapters — `src/docs/content/{fr,en}/<slug>.md`.
 *
 * They are **files**, read at runtime, for the same reasons as the AI's system
 * prompt (`packages/core/src/ai/assets.ts`): Next does not bundle a `.md`, but
 * copies the ones `outputFileTracingIncludes` declares into `standalone`,
 * keeping their path, and the standalone server runs from `apps/web`. A
 * candidate is only kept if it looks like a chapter — Turbopack rewrites
 * `import.meta.url`, and a successful read of the wrong file is the failure that
 * says nothing.
 *
 * `{{origin}}` in a chapter is replaced, at reading time, by the panel's
 * address: the examples are copied and pasted as they are.
 *
 * Not `server-only`: the tests read it, the pages and the MCP endpoint call it.
 */

export type DocChapterSummary = {
  slug: string;
  group: DocGroup;
  title: string;
  summary: string;
};

export type DocChapterContent = DocChapterSummary & {
  markdown: string;
  blocks: Block[];
  headings: DocHeading[];
};

const ROOTS = ['src/docs/content', 'apps/web/src/docs/content'];

const cache = new Map<string, string>();

/** The raw file, `{{origin}}` not yet replaced. */
export function readChapterSource(language: UiLanguage, slug: string): string {
  if (!isDocSlug(slug)) throw new Error(`unknown documentation chapter: ${slug}`);
  const key = `${language}/${slug}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const tried: string[] = [];
  for (const root of ROOTS) {
    const candidate = resolve(process.cwd(), root, language, `${slug}.md`);
    tried.push(candidate);
    let content: string;
    try {
      content = readFileSync(candidate, 'utf8');
    } catch {
      continue;
    }
    if (!content.startsWith('# ')) continue;
    cache.set(key, content);
    return content;
  }
  throw new Error(`documentation chapter ${key} not found — tried ${tried.join(', ')}`);
}

function withOrigin(markdown: string, origin: string): string {
  return markdown.replaceAll('{{origin}}', origin.replace(/\/+$/, ''));
}

function summaryOf(blocks: readonly Block[]): string {
  const first = blocks.find((block) => block.kind === 'paragraph');
  return first?.kind === 'paragraph' ? plainText(first.inline) : '';
}

export function readChapter(language: UiLanguage, slug: string, origin: string): DocChapterContent {
  const chapter = DOC_CHAPTERS.find((candidate) => candidate.slug === slug);
  if (!chapter) throw new Error(`unknown documentation chapter: ${slug}`);
  const markdown = withOrigin(readChapterSource(language, slug), origin);
  const blocks = parseMarkdown(markdown);
  const title = blocks[0]?.kind === 'heading' ? blocks[0].text : slug;
  return {
    slug,
    group: chapter.group,
    title,
    summary: summaryOf(blocks),
    markdown,
    blocks,
    headings: headingsOf(blocks),
  };
}

export function listChapters(language: UiLanguage, origin: string): DocChapterSummary[] {
  return DOC_CHAPTERS.map((chapter) => {
    const { slug, group, title, summary } = readChapter(language, chapter.slug, origin);
    return { slug, group, title, summary };
  });
}

/* ─── Search ───────────────────────────────────────────────────────────────── */

export type DocSearchHit = {
  slug: string;
  chapter: string;
  /** The section the text was found in; `null` before the first heading. */
  section: { id: string; text: string } | null;
  excerpt: string;
  score: number;
};

/** Lowercase, without accents: "deploiement" finds "Déploiement". */
function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function excerptAround(text: string, terms: readonly string[]): string {
  const folded = fold(text);
  const at = Math.min(...terms.map((term) => folded.indexOf(term)).filter((index) => index >= 0));
  const start = Number.isFinite(at) ? Math.max(0, at - 80) : 0;
  const slice = text.slice(start, start + 220).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${slice}${start + 220 < text.length ? '…' : ''}`;
}

/**
 * Sections where **every** word of the query appears — in the section's heading
 * or its text. A heading that matches ranks first: whoever types "rollback"
 * wants the section on rolling back, not every paragraph that mentions it.
 */
export function searchDocs(
  language: UiLanguage,
  query: string,
  origin: string,
  limit = 20,
): DocSearchHit[] {
  const terms = fold(query)
    .split(/\s+/)
    .map((term) => term.replace(/[^a-z0-9:/._-]/g, ''))
    .filter((term) => term.length >= 2);
  if (terms.length === 0) return [];

  const hits: DocSearchHit[] = [];
  for (const chapter of DOC_CHAPTERS) {
    const content = readChapter(language, chapter.slug, origin);
    let section: DocSearchHit['section'] = null;
    let buffer: string[] = [];

    const flush = () => {
      const text = buffer.join(' ');
      const heading = section?.text ?? content.title;
      const haystack = fold(`${heading} ${text}`);
      if (terms.every((term) => haystack.includes(term))) {
        const inHeading = terms.filter((term) => fold(heading).includes(term)).length;
        const occurrences = terms.reduce(
          (total, term) => total + haystack.split(term).length - 1,
          0,
        );
        hits.push({
          slug: chapter.slug,
          chapter: content.title,
          section,
          excerpt: excerptAround(text || heading, terms),
          score: inHeading * 10 + Math.min(occurrences, 10),
        });
      }
      buffer = [];
    };

    for (const block of content.blocks.slice(1)) {
      if (block.kind === 'heading' && block.level <= 3) {
        flush();
        section = { id: block.id, text: block.text };
        continue;
      }
      buffer.push(blockText(block));
    }
    flush();
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
