/**
 * A mini lexer of TypeScript/TSX — just enough to answer one question: "where are
 * the strings and the JSX texts, and what is only a comment?"
 *
 * Why not a regular expression: because it gets `'http://exemple'` wrong (it
 * takes it for a comment), `// il a dit "x"` (from which it extracts a false
 * string) and nested templates. A guard that cries wolf one time in ten ends up
 * disabled, and a second language dies the day its guard is disabled.
 *
 * Why not the TypeScript compiler: it is there, but loading it would make this
 * test slow and dependent. The scan below is a hundred lines, it is exact on what
 * it is asked, and it costs nothing.
 */

/**
 * Returns a source's string literals and JSX texts, each with its line. Comments
 * are ignored: the project's language is English, and this file has nothing to
 * say about them.
 */
export function scanSource(source, { jsx = true } = {}) {
  const strings = [];
  const jsxTexts = [];

  let i = 0;
  let line = 1;
  const n = source.length;

  const at = (offset = 0) => source[i + offset];

  /**
   * The last character that counts for the grammar — neither a space nor a comment.
   * It only serves to decide between a division and a regular expression.
   */
  let lastSignificant = '';

  /** Does a `/` here open a regular expression rather than a division? */
  function startsRegex() {
    if (lastSignificant === '') return true;
    return !/[)\]}\w$'"`]/.test(lastSignificant);
  }

  function advance(count = 1) {
    for (let k = 0; k < count; k += 1) {
      if (source[i] === '\n') line += 1;
      i += 1;
    }
  }

  /** Swallows a `…` template, noting its literal pieces. */
  function readTemplate() {
    const startLine = line;
    advance(); // le backtick ouvrant
    let chunk = '';
    while (i < n) {
      if (at() === '\\') {
        chunk += at(1) ?? '';
        advance(2);
        continue;
      }
      if (at() === '`') {
        advance();
        break;
      }
      if (at() === '$' && at(1) === '{') {
        if (chunk !== '') strings.push({ value: chunk, line: startLine });
        chunk = '';
        advance(2);
        // We skip the interpolation by counting the braces. The code it contains is only
        // scanned again at the next round if it carries a template itself — which the
        // counting crosses without eating it.
        let depth = 1;
        while (i < n && depth > 0) {
          if (at() === '{') depth += 1;
          else if (at() === '}') depth -= 1;
          else if (at() === '`') {
            readTemplate();
            continue;
          } else if (at() === "'" || at() === '"') {
            readQuoted(at());
            continue;
          }
          advance();
        }
        continue;
      }
      chunk += at();
      advance();
    }
    if (chunk !== '') strings.push({ value: chunk, line: startLine });
  }

  /** Swallows a `'…'` or `"…"` string. */
  function readQuoted(quote) {
    const startLine = line;
    advance();
    let value = '';
    while (i < n && at() !== quote) {
      if (at() === '\\') {
        value += at(1) ?? '';
        advance(2);
        continue;
      }
      if (at() === '\n') break; // unterminated string: we do not guess
      value += at();
      advance();
    }
    advance();
    strings.push({ value, line: startLine });
  }

  /**
   * Three calls whose content is never shown to anyone, and which the guard must
   * therefore cross without noting anything:
   *
   *   `logger.*()`   — Pino logging, `log.*()` included (a child logger, in the
   *                    worker). The project's language is English, as CLAUDE.md
   *                    says, and an operator reading `docker compose logs` is not
   *                    a user.
   *   `console.*()`  — the startup warnings, the same status.
   *   `new Error()`  — a programming invariant. It has no screen; if it is ever
   *                    shown, it is already a more serious bug than its language.
   *                    The errors *meant* for the user go through `HttpError` and
   *                    its subclasses, which are not covered by this exception.
   *
   * We skip the whole call, balanced parentheses, respecting the strings it
   * contains — otherwise a parenthesis in a message would close the counting too
   * early.
   */
  function atIgnoredCall() {
    // At the start of a word only: `dialog.info(` is not a call to `log`.
    if (i > 0 && /[\w$]/.test(source[i - 1] ?? '')) return false;
    const rest = source.slice(i, i + 40);
    return (
      /^(?:logger|log)\s*\.\s*(?:trace|debug|info|warn|error|fatal)\s*\(/.test(rest) ||
      /^console\s*\.\s*\w+\s*\(|^new\s+Error\s*\(/.test(rest)
    );
  }

  function skipCall() {
    while (i < n && at() !== '(') advance();
    let depth = 0;
    while (i < n) {
      const c = at();
      if (c === '(') depth += 1;
      else if (c === ')') {
        depth -= 1;
        advance();
        if (depth === 0) return;
        continue;
      } else if (c === "'" || c === '"') {
        const quote = c;
        advance();
        while (i < n && at() !== quote) {
          if (at() === '\\') advance();
          advance();
        }
      } else if (c === '`') {
        advance();
        while (i < n && at() !== '`') {
          if (at() === '\\') advance();
          advance();
        }
      }
      advance();
    }
  }

  while (i < n) {
    const c = at();

    if ((c === 'l' || c === 'c' || c === 'n') && atIgnoredCall()) {
      skipCall();
      continue;
    }

    if (c === '/' && at(1) === '/') {
      while (i < n && at() !== '\n') advance();
      lastSignificant = ';';
      continue;
    }
    if (c === '/' && at(1) === '*') {
      advance(2);
      while (i < n && !(at() === '*' && at(1) === '/')) advance();
      advance(2);
      continue;
    }

    /**
     * A regular expression, swallowed in one block.
     *
     * Without this case, `/(`+'`'+`[^`+'`'+`]+`+'`'+`|\\*\\*[^*]+\\*\\*)/g` opened a false template:
     * the lexer went looking for a closing backtick and swallowed the eighty
     * following lines, comments included, which it then returned as a "French"
     * string. The guard then accused the only file that had taken the trouble of
     * making itself translatable.
     *
     * Telling a regular expression from a division requires context: after a value
     * (`)`, `]`, an identifier, a number) the `/` divides; after an operator, a comma
     * or an opening one, it opens a regex.
     */
    if (c === '/' && startsRegex()) {
      advance();
      let inClass = false;
      while (i < n) {
        if (at() === '\\') {
          advance(2);
          continue;
        }
        if (at() === '[') inClass = true;
        else if (at() === ']') inClass = false;
        else if (at() === '/' && !inClass) {
          advance();
          break;
        } else if (at() === '\n') break;
        advance();
      }
      while (i < n && /[dgimsuvy]/.test(at() ?? '')) advance();
      lastSignificant = ')';
      continue;
    }

    if (c === "'" || c === '"') {
      readQuoted(c);
      lastSignificant = ')';
      continue;
    }
    if (c === '`') {
      readTemplate();
      lastSignificant = ')';
      continue;
    }

    /**
     * JSX text. We do not follow the grammar: we note what separates a `>` from a
     * `<`, a `{` or another `>`. A `a > b` in code produces a fragment without a
     * French word, hence without consequence.
     *
     * The scan also stops at a comment's start: without that, a `=>` followed by a
     * `/** … *\/` block would make the comment's prose pass for displayed text — and
     * the guard would report comments, which it has no right to do.
     *
     * `.ts` files have no JSX at all: we do not look for it.
     */
    if (c === '>' && jsx) {
      const startLine = line;
      advance();
      let value = '';
      while (
        i < n &&
        at() !== '<' &&
        at() !== '{' &&
        at() !== '>' &&
        at() !== '`' &&
        !(at() === '/' && (at(1) === '/' || at(1) === '*'))
      ) {
        value += at();
        advance();
      }
      if (value.trim() !== '') jsxTexts.push({ value: value.trim(), line: startLine });
      lastSignificant = '>';
      continue;
    }

    if (!/\s/.test(c)) lastSignificant = c;
    advance();
  }

  return { strings, jsxTexts };
}
