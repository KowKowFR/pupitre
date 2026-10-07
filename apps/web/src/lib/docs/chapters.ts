/**
 * The in-panel documentation's table of contents — a single list for the
 * `/docs` pages, the ⌘K palette and the MCP endpoint's `docs` tool and resources.
 *
 * Each chapter is one Markdown file per language,
 * `src/docs/content/{fr,en}/<slug>.md`. Its title is its first line (`# …`), its
 * summary the paragraph that follows: nothing to keep in sync here but the order.
 * `test/docs.test.mjs` checks that every chapter exists in both languages, with
 * the same sections.
 *
 * A pure module, without React: it serves the pages, the palette and the tests.
 */

export const DOC_GROUPS = ['start', 'guides', 'automation', 'reference'] as const;
export type DocGroup = (typeof DOC_GROUPS)[number];

export type DocChapter = { slug: string; group: DocGroup };

export const DOC_CHAPTERS: readonly DocChapter[] = [
  { slug: 'introduction', group: 'start' },
  { slug: 'quick-start', group: 'start' },
  { slug: 'concepts', group: 'start' },
  { slug: 'targets', group: 'guides' },
  { slug: 'proxy-and-domains', group: 'guides' },
  { slug: 'applications', group: 'guides' },
  { slug: 'appspec', group: 'guides' },
  { slug: 'deployments', group: 'guides' },
  { slug: 'repositories', group: 'guides' },
  { slug: 'security-scans', group: 'guides' },
  { slug: 'operations', group: 'guides' },
  { slug: 'administration', group: 'guides' },
  { slug: 'api', group: 'automation' },
  { slug: 'ci-cd', group: 'automation' },
  { slug: 'mcp', group: 'automation' },
  { slug: 'troubleshooting', group: 'reference' },
];

export function isDocSlug(value: string): boolean {
  return DOC_CHAPTERS.some((chapter) => chapter.slug === value);
}

/** The chapters before and after, for the foot of a page. */
export function neighbors(slug: string): { previous: DocChapter | null; next: DocChapter | null } {
  const index = DOC_CHAPTERS.findIndex((chapter) => chapter.slug === slug);
  if (index === -1) return { previous: null, next: null };
  return {
    previous: DOC_CHAPTERS[index - 1] ?? null,
    next: DOC_CHAPTERS[index + 1] ?? null,
  };
}
