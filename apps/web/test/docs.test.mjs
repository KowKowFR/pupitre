import { strict as assert } from 'node:assert';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isFrench } from './french.mjs';

/**
 * The in-panel documentation: the Markdown it understands, and the guard that
 * keeps its two languages together — the same chapters, the same sections, the
 * same examples, no French left on the English side, no link that leads
 * nowhere. The dictionaries' guard (`i18n.test.mjs`) does not read `.md` files:
 * this one does.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(here, '..');
const contentRoot = path.join(webRoot, 'src', 'docs', 'content');
const pagesRoot = path.join(webRoot, 'src', 'app', '(app)');

const { parseMarkdown, parseInline, slugify, headingsOf, plainText } = await import(
  '../src/lib/docs/markdown.ts'
);
const { DOC_CHAPTERS, neighbors } = await import('../src/lib/docs/chapters.ts');
const { readChapter, readChapterSource, searchDocs, listChapters } = await import(
  '../src/lib/docs/content.ts'
);

describe('docs — the Markdown it reads', () => {
  it('headings, with stable and unique anchors', () => {
    const blocks = parseMarkdown('# Titre\n\n## Déployer depuis une CI\n\n## Exemple\n\n### Exemple');
    assert.deepEqual(
      blocks.map((block) => [block.kind, block.level, block.id]),
      [
        ['heading', 1, 'titre'],
        ['heading', 2, 'deployer-depuis-une-ci'],
        ['heading', 2, 'exemple'],
        ['heading', 3, 'exemple-2'],
      ],
    );
    assert.deepEqual(headingsOf(blocks).map((heading) => heading.id), ['deployer-depuis-une-ci', 'exemple', 'exemple-2']);
    assert.equal(slugify('`POST /api/deployments`'), 'post-api-deployments');
  });

  it('inline: code, bold, italic, links — and an underscore stays an underscore', () => {
    assert.deepEqual(parseInline('**gras** et *italique*, `deploy_to`, [lien](/docs/api#x)'), [
      { kind: 'strong', children: [{ kind: 'text', text: 'gras' }] },
      { kind: 'text', text: ' et ' },
      { kind: 'em', children: [{ kind: 'text', text: 'italique' }] },
      { kind: 'text', text: ', ' },
      { kind: 'code', text: 'deploy_to' },
      { kind: 'text', text: ', ' },
      { kind: 'link', href: '/docs/api#x', children: [{ kind: 'text', text: 'lien' }] },
    ]);
    assert.equal(plainText(parseInline('snake_case_name and 2 * 3 * 4')), 'snake_case_name and 2 * 3 * 4');
    assert.equal(plainText(parseInline('\\*not italic\\*')), '*not italic*');
  });

  it('a paragraph joins its lines', () => {
    const [block] = parseMarkdown('one\ntwo\nthree');
    assert.equal(plainText(block.inline), 'one two three');
  });

  it('a procedure: numbered steps carrying their command, a nested list', () => {
    const blocks = parseMarkdown(
      [
        '1. Create the token:',
        '',
        '   ```bash',
        '   export PUPITRE_TOKEN=pup_x',
        '     indented',
        '   ```',
        '',
        '2. Choose:',
        '   - a target',
        '   - a runtime',
        '3. Deploy.',
        '',
        'After.',
      ].join('\n'),
    );
    assert.equal(blocks.length, 2);
    const [list, after] = blocks;
    assert.equal(list.kind, 'list');
    assert.equal(list.ordered, true);
    assert.equal(list.items.length, 3);
    assert.deepEqual(list.items[0].map((block) => block.kind), ['paragraph', 'code']);
    assert.equal(list.items[0][1].lang, 'bash');
    assert.equal(list.items[0][1].text, 'export PUPITRE_TOKEN=pup_x\n  indented');
    assert.deepEqual(list.items[1].map((block) => block.kind), ['paragraph', 'list']);
    assert.equal(list.items[1][1].items.length, 2);
    assert.equal(plainText(after.inline), 'After.');
  });

  it('a list whose items are separated by blank lines stays one list', () => {
    const blocks = parseMarkdown('- a\n\n- b\n\n- c');
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].items.length, 3);
  });

  it("callouts, GitHub's way", () => {
    const [warning, note] = parseMarkdown('> [!WARNING]\n> Irreversible.\n\n> A plain quote.');
    assert.equal(warning.kind, 'callout');
    assert.equal(warning.tone, 'warning');
    assert.equal(plainText(warning.blocks[0].inline), 'Irreversible.');
    assert.equal(note.tone, 'note');
  });

  it('tables, with alignment and an escaped pipe', () => {
    const [table] = parseMarkdown('| Code | Meaning |\n|:---|---:|\n| `a\\|b` | x |\n| 401 | no token |');
    assert.equal(table.kind, 'table');
    assert.deepEqual(table.align, ['left', 'right']);
    assert.equal(table.rows.length, 2);
    assert.deepEqual(table.rows[0][0], [{ kind: 'code', text: 'a|b' }]);
  });

  it('a fenced block keeps everything, Markdown included', () => {
    const [code] = parseMarkdown('```json\n{ "a": "# not a heading" }\n- not a list\n```');
    assert.equal(code.kind, 'code');
    assert.equal(code.text, '{ "a": "# not a heading" }\n- not a list');
  });

  it('a rule', () => {
    assert.deepEqual(parseMarkdown('---').map((block) => block.kind), ['rule']);
  });
});

/* ─── The chapters ─────────────────────────────────────────────────────────── */

const LANGUAGES = ['fr', 'en'];

function walkBlocks(blocks, visit) {
  for (const block of blocks) {
    visit(block);
    if (block.kind === 'list') for (const item of block.items) walkBlocks(item, visit);
    if (block.kind === 'callout') walkBlocks(block.blocks, visit);
  }
}

function inlineNodes(blocks) {
  const nodes = [];
  const collect = (inline) => {
    for (const node of inline) {
      nodes.push(node);
      if (node.kind === 'strong' || node.kind === 'em' || node.kind === 'link') collect(node.children);
    }
  };
  walkBlocks(blocks, (block) => {
    if (block.kind === 'heading' || block.kind === 'paragraph') collect(block.inline);
    if (block.kind === 'table') for (const row of [block.header, ...block.rows]) for (const cell of row) collect(cell);
  });
  return nodes;
}

/** Prose only — the text a reader reads, inline code excepted. */
function prose(inline) {
  return inline
    .map((node) =>
      node.kind === 'text' ? node.text : node.kind === 'code' ? ' ' : prose(node.children),
    )
    .join('');
}

const ORIGIN = 'https://pupitre.example.com';
const chapter = (language, slug) => readChapter(language, slug, ORIGIN);

describe('docs — the chapters', () => {
  it('each chapter exists in both languages, and nothing else is there', () => {
    for (const language of LANGUAGES) {
      const files = readdirSync(path.join(contentRoot, language)).sort();
      assert.deepEqual(files, DOC_CHAPTERS.map((entry) => `${entry.slug}.md`).sort(), language);
    }
  });

  it('each opens on its title, then a summary', () => {
    for (const language of LANGUAGES) {
      for (const { slug } of DOC_CHAPTERS) {
        const content = chapter(language, slug);
        assert.equal(content.blocks[0].kind, 'heading', `${language}/${slug}`);
        assert.equal(content.blocks[0].level, 1, `${language}/${slug}`);
        assert.ok(content.summary.length > 40, `${language}/${slug}: a summary under the title`);
        const titles = content.blocks.filter((block) => block.kind === 'heading' && block.level === 1);
        assert.equal(titles.length, 1, `${language}/${slug}: a single title`);
      }
    }
  });

  it('the two languages have the same sections and the same examples', () => {
    for (const { slug } of DOC_CHAPTERS) {
      const [fr, en] = LANGUAGES.map((language) => chapter(language, slug));
      const shape = (content) =>
        content.blocks.filter((block) => block.kind === 'heading').map((block) => block.level).join('');
      assert.equal(shape(fr), shape(en), `${slug}: not the same headings`);

      const codes = (content) => {
        const found = [];
        walkBlocks(content.blocks, (block) => {
          if (block.kind === 'code') found.push(block.lang ?? '');
        });
        return found;
      };
      assert.deepEqual(codes(fr), codes(en), `${slug}: not the same code blocks`);

      const tables = (content) => {
        const found = [];
        walkBlocks(content.blocks, (block) => {
          if (block.kind === 'table') found.push(`${block.header.length}×${block.rows.length}`);
        });
        return found;
      };
      assert.deepEqual(tables(fr), tables(en), `${slug}: not the same tables`);
    }
  });

  it('the English side left no French behind', () => {
    const problems = [];
    for (const { slug } of DOC_CHAPTERS) {
      const content = chapter('en', slug);
      walkBlocks(content.blocks, (block) => {
        const texts =
          block.kind === 'heading' || block.kind === 'paragraph'
            ? [prose(block.inline)]
            : block.kind === 'table'
              ? [block.header, ...block.rows].flatMap((row) => row.map(prose))
              : [];
        for (const text of texts) if (isFrench(text)) problems.push(`en/${slug}: "${text.slice(0, 80)}"`);
      });
    }
    assert.deepEqual(problems, []);
  });

  it('every link leads somewhere: a chapter and its section, a page of the panel', () => {
    const problems = [];
    for (const language of LANGUAGES) {
      const anchors = new Map(
        DOC_CHAPTERS.map(({ slug }) => [
          slug,
          new Set(chapter(language, slug).blocks.filter((block) => block.kind === 'heading').map((block) => block.id)),
        ]),
      );
      for (const { slug } of DOC_CHAPTERS) {
        for (const node of inlineNodes(chapter(language, slug).blocks)) {
          if (node.kind !== 'link') continue;
          const href = node.href;
          const where = `${language}/${slug} → ${href}`;
          if (/^(https?:|mailto:)/.test(href)) continue;
          if (href.startsWith('#')) {
            if (!anchors.get(slug).has(href.slice(1))) problems.push(`${where}: no such section`);
            continue;
          }
          if (!href.startsWith('/')) {
            problems.push(`${where}: a link is absolute, an anchor or a panel path`);
            continue;
          }
          const [pathname, anchor] = href.split('#');
          const docs = /^\/docs\/([a-z0-9-]+)$/.exec(pathname);
          if (docs) {
            if (!anchors.has(docs[1])) problems.push(`${where}: no such chapter`);
            else if (anchor && !anchors.get(docs[1]).has(anchor)) problems.push(`${where}: no such section`);
            continue;
          }
          if (pathname === '/docs') continue;
          const page = path.join(pagesRoot, pathname.split('?')[0], 'page.tsx');
          if (!existsSync(page)) problems.push(`${where}: no such page`);
        }
      }
    }
    assert.deepEqual(problems, []);
  });

  it('only {{origin}} is substituted, and it is', () => {
    for (const language of LANGUAGES) {
      for (const { slug } of DOC_CHAPTERS) {
        const source = readChapterSource(language, slug);
        // `${{ secrets.X }}` is a GitHub Actions expression, not one of ours.
        const placeholders = [...source.matchAll(/(?<!\$)\{\{\s*([^}]+?)\s*\}\}/g)].map((match) => match[1]);
        assert.deepEqual([...new Set(placeholders)].filter((name) => name !== 'origin'), [], `${language}/${slug}`);
        assert.ok(!chapter(language, slug).markdown.includes('{{origin}}'));
      }
    }
  });
});

describe('docs — finding one’s way', () => {
  it('the table of contents follows the declared order', () => {
    assert.deepEqual(
      listChapters('en', ORIGIN).map((entry) => entry.slug),
      DOC_CHAPTERS.map((entry) => entry.slug),
    );
    assert.equal(neighbors(DOC_CHAPTERS[0].slug).previous, null);
    assert.equal(neighbors(DOC_CHAPTERS[1].slug).previous.slug, DOC_CHAPTERS[0].slug);
  });

  it('the search needs every word, ignores accents, and ranks a heading first', () => {
    const hits = searchDocs('fr', 'deploiement', ORIGIN);
    assert.ok(hits.length > 0);
    const mcp = searchDocs('en', 'MCP token', ORIGIN);
    assert.ok(mcp.some((hit) => hit.slug === 'mcp'));
    assert.deepEqual(searchDocs('en', 'zzzzqqqq', ORIGIN), []);
    assert.deepEqual(searchDocs('en', 'a', ORIGIN), []);
  });

  it('the examples carry the panel’s address', () => {
    assert.ok(chapter('en', 'mcp').markdown.includes(`${ORIGIN}/api/mcp`));
  });
});
