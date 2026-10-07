/**
 * The documentation's Markdown, read into a tree — the subset its chapters use,
 * and nothing more.
 *
 * ── Why not a library ───────────────────────────────────────────────────────
 * A complete Markdown engine produces HTML, which then has to be injected
 * (`dangerouslySetInnerHTML`) and styled from the outside. Here the tree is
 * rendered by React components (`components/docs/markdown-view.tsx`): a code
 * block gets its copy button, an internal link becomes a `<Link>`, a callout the
 * design system's colors — and no HTML from a file ever reaches the page. The
 * subset is ours, since we write the chapters: when a chapter needs a new
 * construct, it is added here, with its test.
 *
 * What is understood:
 *   - `#` to `####` headings, each with a stable anchor;
 *   - paragraphs; `**bold**`, `*italic*`, `` `code` ``, `[text](href)`;
 *   - `-` and `1.` lists, nested by indentation, with paragraphs and code blocks
 *     inside an item — a procedure's steps carry their command;
 *   - fenced code blocks, with their language;
 *   - GitHub's callouts: `> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`,
 *     `[!CAUTION]` — a plain `>` is a note;
 *   - tables, with their column alignment;
 *   - `---`, a horizontal rule.
 *
 * A pure module, without React: it serves the pages, the search and the tests.
 */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] }
  | { kind: 'link'; href: string; children: Inline[] };

export type CalloutTone = 'note' | 'tip' | 'important' | 'warning' | 'caution';
export type Align = 'left' | 'center' | 'right' | null;

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4; id: string; text: string; inline: Inline[] }
  | { kind: 'paragraph'; inline: Inline[] }
  | { kind: 'code'; lang: string | null; text: string }
  | { kind: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { kind: 'callout'; tone: CalloutTone; blocks: Block[] }
  | { kind: 'table'; align: Align[]; header: Inline[][]; rows: Inline[][][] }
  | { kind: 'rule' };

/* ─── Anchors ──────────────────────────────────────────────────────────────── */

/** `Déployer depuis une CI` → `deployer-depuis-une-ci`. */
export function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The text of an inline tree, without its markup. */
export function plainText(inline: readonly Inline[]): string {
  return inline
    .map((node) => (node.kind === 'text' || node.kind === 'code' ? node.text : plainText(node.children)))
    .join('');
}

/* ─── Inline ───────────────────────────────────────────────────────────────── */

function pushText(out: Inline[], text: string): void {
  if (text === '') return;
  const last = out[out.length - 1];
  if (last?.kind === 'text') last.text += text;
  else out.push({ kind: 'text', text });
}

/** Where the closing `marker` is, at or after `from`, not preceded by a backslash. */
function closing(source: string, marker: string, from: number): number {
  let index = source.indexOf(marker, from);
  while (index > 0 && source[index - 1] === '\\') index = source.indexOf(marker, index + 1);
  return index;
}

export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i]!;

    if (char === '\\' && i + 1 < source.length && /[\\`*_[\]()|#>!-]/.test(source[i + 1]!)) {
      pushText(out, source[i + 1]!);
      i += 2;
      continue;
    }

    if (char === '`') {
      const end = source.indexOf('`', i + 1);
      if (end > i) {
        out.push({ kind: 'code', text: source.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    if (source.startsWith('**', i)) {
      const end = closing(source, '**', i + 2);
      if (end > i + 2) {
        out.push({ kind: 'strong', children: parseInline(source.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }

    // `*` only: an underscore is too common in identifiers (`deploy_to`) to mean
    // emphasis.
    if (char === '*' && source[i + 1] !== ' ') {
      const end = closing(source, '*', i + 1);
      if (end > i + 1 && source[end - 1] !== ' ') {
        out.push({ kind: 'em', children: parseInline(source.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }

    if (char === '[') {
      const labelEnd = closing(source, ']', i + 1);
      if (labelEnd > i && source[labelEnd + 1] === '(') {
        const hrefEnd = source.indexOf(')', labelEnd + 2);
        if (hrefEnd > labelEnd) {
          out.push({
            kind: 'link',
            href: source.slice(labelEnd + 2, hrefEnd).trim(),
            children: parseInline(source.slice(i + 1, labelEnd)),
          });
          i = hrefEnd + 1;
          continue;
        }
      }
    }

    pushText(out, char);
    i += 1;
  }
  return out;
}

/* ─── Blocks ───────────────────────────────────────────────────────────────── */

const HEADING = /^(#{1,4})\s+(.+?)\s*#*\s*$/;
const FENCE = /^(\s*)(`{3,}|~{3,})\s*([\w+-]*)/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,3})[.)]\s+(.*)$/;
const RULE = /^\s*(?:-\s*){3,}$|^\s*(?:\*\s*){3,}$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const CALLOUT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function splitRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  const cells: string[] = [];
  let current = '';
  let inCode = false;
  for (let i = 0; i < row.length; i += 1) {
    const char = row[i]!;
    if (char === '\\' && row[i + 1] === '|') {
      current += '|';
      i += 1;
      continue;
    }
    if (char === '`') inCode = !inCode;
    if (char === '|' && !inCode) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function alignOf(cell: string): Align {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}

/** Anchors stay unique across the whole chapter: `#exemple`, `#exemple-2`. */
class Slugger {
  private readonly seen = new Map<string, number>();
  next(text: string): string {
    const base = slugify(text) || 'section';
    const count = this.seen.get(base) ?? 0;
    this.seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count + 1}`;
  }
}

function isBlockStart(line: string): boolean {
  return (
    HEADING.test(line) ||
    FENCE.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line) ||
    line.trimStart().startsWith('>') ||
    RULE.test(line)
  );
}

function parseLines(lines: readonly string[], slugger: Slugger): Block[] {
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') {
      i += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const indent = fence[1]!.length;
      const marker = fence[2]!;
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trimStart().startsWith(marker)) {
        const raw = lines[i]!;
        body.push(indentOf(raw) >= indent ? raw.slice(indent) : raw.trimStart());
        i += 1;
      }
      i += 1; // the closing fence
      blocks.push({ kind: 'code', lang: fence[3] || null, text: body.join('\n') });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading && indentOf(line) === 0) {
      const text = heading[2]!;
      const inline = parseInline(text);
      blocks.push({
        kind: 'heading',
        level: heading[1]!.length as 1 | 2 | 3 | 4,
        id: slugger.next(plainText(inline)),
        text: plainText(inline),
        inline,
      });
      i += 1;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' });
      i += 1;
      continue;
    }

    if (line.trimStart().startsWith('>')) {
      const quoted: string[] = [];
      while (i < lines.length && lines[i]!.trimStart().startsWith('>')) {
        quoted.push(lines[i]!.trimStart().replace(/^>\s?/, ''));
        i += 1;
      }
      const marker = CALLOUT.exec(quoted[0] ?? '');
      const tone = (marker ? marker[1]!.toLowerCase() : 'note') as CalloutTone;
      blocks.push({
        kind: 'callout',
        tone,
        blocks: parseLines(marker ? quoted.slice(1) : quoted, slugger),
      });
      continue;
    }

    const bullet = BULLET.exec(line);
    const ordered = bullet ? null : ORDERED.exec(line);
    if (bullet || ordered) {
      const match = (bullet ?? ordered)!;
      const baseIndent = match[1]!.length;
      const isOrdered = ordered !== null;
      const items: Block[][] = [];
      const itemPattern = isOrdered ? ORDERED : BULLET;

      while (i < lines.length) {
        const current = itemPattern.exec(lines[i]!);
        if (!current || current[1]!.length !== baseIndent) break;
        // The item's content starts after its marker: continuation lines are
        // indented at least that much, nested lists included.
        const contentIndent = lines[i]!.length - current[3]!.length;
        const itemLines = [current[3]!];
        i += 1;
        while (i < lines.length) {
          const next = lines[i]!;
          if (next.trim() === '') {
            // A blank line ends the item unless what follows is still indented.
            const following = lines.slice(i + 1).find((candidate) => candidate.trim() !== '');
            if (following !== undefined && indentOf(following) >= Math.min(contentIndent, baseIndent + 2)) {
              itemLines.push('');
              i += 1;
              continue;
            }
            break;
          }
          if (indentOf(next) >= Math.min(contentIndent, baseIndent + 2)) {
            itemLines.push(next.slice(Math.min(indentOf(next), contentIndent)));
            i += 1;
            continue;
          }
          // A lazy continuation: a plain line right under the item's text.
          if (indentOf(next) === baseIndent && !isBlockStart(next) && itemLines[itemLines.length - 1] !== '') {
            itemLines.push(next.trim());
            i += 1;
            continue;
          }
          break;
        }
        items.push(parseLines(itemLines, slugger));
        // Blank lines between two items of the same list.
        let peek = i;
        while (peek < lines.length && lines[peek]!.trim() === '') peek += 1;
        const again = peek < lines.length ? itemPattern.exec(lines[peek]!) : null;
        if (again && again[1]!.length === baseIndent) i = peek;
      }

      blocks.push({
        kind: 'list',
        ordered: isOrdered,
        start: isOrdered ? Number(ordered![2]) : 1,
        items,
      });
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1]!)) {
      const header = splitRow(line);
      const align = splitRow(lines[i + 1]!).map(alignOf);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim() !== '') {
        const cells = splitRow(lines[i]!);
        rows.push(header.map((_, index) => parseInline(cells[index] ?? '')));
        i += 1;
      }
      blocks.push({ kind: 'table', align, header: header.map(parseInline), rows });
      continue;
    }

    const paragraph: string[] = [line.trim()];
    i += 1;
    while (i < lines.length && lines[i]!.trim() !== '' && !isBlockStart(lines[i]!)) {
      if (lines[i]!.includes('|') && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1]!)) break;
      paragraph.push(lines[i]!.trim());
      i += 1;
    }
    blocks.push({ kind: 'paragraph', inline: parseInline(paragraph.join(' ')) });
  }

  return blocks;
}

export function parseMarkdown(source: string): Block[] {
  return parseLines(source.replace(/\r\n?/g, '\n').split('\n'), new Slugger());
}

/* ─── What the pages and the search read ───────────────────────────────────── */

export type DocHeading = { level: 2 | 3; id: string; text: string };

/** The `##` and `###` of a chapter, top level only — the "On this page" column. */
export function headingsOf(blocks: readonly Block[]): DocHeading[] {
  return blocks.flatMap((block) =>
    block.kind === 'heading' && (block.level === 2 || block.level === 3)
      ? [{ level: block.level, id: block.id, text: block.text }]
      : [],
  );
}

/** A block's readable text, for the search. */
export function blockText(block: Block): string {
  switch (block.kind) {
    case 'heading':
      return block.text;
    case 'paragraph':
      return plainText(block.inline);
    case 'code':
      return block.text;
    case 'list':
      return block.items.map((item) => item.map(blockText).join(' ')).join(' ');
    case 'callout':
      return block.blocks.map(blockText).join(' ');
    case 'table':
      return [block.header, ...block.rows]
        .map((row) => row.map((cell) => plainText(cell)).join(' '))
        .join(' ');
    case 'rule':
      return '';
  }
}
