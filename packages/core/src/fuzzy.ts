/**
 * The ⌘K palette's tolerant matching: what is typed, against what an object
 * carries (name, slug, host, labels…).
 *
 * Tolerant, but not so fuzzy that it returns everything:
 *
 * - accents and case do not count ("deploiement" finds "Déploiement");
 * - **each typed word must match** somewhere: "api prod" does not return
 *   everything that contains "prod";
 * - a word matches, from strongest to weakest: the whole field, a word start, a
 *   piece of a word, then — from three letters — the letters in order ("prd1" →
 *   "prod-1"), or a typo ("umamo" → "umami", one letter wrong, extra, missing or
 *   swapped; two from eight letters).
 *
 * The score is used for ranking: an object that matches by its name goes before
 * an object that matches through a typo.
 */

/** Without accents, lowercase. */
export function foldText(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** The words of an input, folded. The `#` of a run number drops. */
export function queryTokens(query: string): string[] {
  return foldText(query)
    .split(/\s+/)
    .map((token) => token.replace(/^#/, ''))
    .filter((token) => token !== '');
}

function wordsOf(field: string): string[] {
  return field.split(/[^a-z0-9]+/).filter((word) => word !== '');
}

/** Do the letters of `token` appear in order in `text`? */
function isSubsequence(token: string, text: string): boolean {
  let index = 0;
  for (const char of text) {
    if (char === token[index]) index += 1;
    if (index === token.length) return true;
  }
  return false;
}

/**
 * Damerau-Levenshtein distance (optimal alignment), bounded: beyond `max`, we
 * stop and return `max + 1`.
 */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) =>
    Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i < rows; i += 1) {
    let rowMin = Number.POSITIVE_INFINITY;
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, d[i - 2]![j - 2]! + 1);
      }
      d[i]![j] = value;
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length]![b.length]!;
}

/**
 * What a typed word is worth against a field: 0 if it does not match. A prose
 * field (a description) only matches a real piece of text: letters in order and
 * typos would find anything in a sentence.
 */
function tokenScore(token: string, field: string, prose: boolean): number {
  if (field === token) return 5;
  const words = wordsOf(field);
  if (field.startsWith(token) || words.some((word) => word.startsWith(token))) return 4;
  if (field.includes(token)) return 3;
  if (prose) return 0;
  // The words, the whole field, and the field without separators: "prd1" reads in
  // "prod-1", "portail-cleint" against "portail-client".
  const compact = field.replace(/[^a-z0-9]/g, '');
  const candidates = [...words, field, compact];
  // Letters in order, but starting like the word, and in a word hardly longer than
  // the input: "prd1" for "prod-1", not "umamo" scattered across
  // "open-webui-documentation".
  if (
    token.length >= 3 &&
    candidates.some(
      (word) =>
        word[0] === token[0] && word.length <= token.length * 2 && isSubsequence(token, word),
    )
  ) {
    return 2;
  }
  if (token.length >= 4) {
    const allowed = token.length >= 8 ? 2 : 1;
    // Against the whole word, or against its start of the same length: "umam" typed
    // for "umami" must not be punished for the missing letter.
    if (
      candidates.some(
        (word) =>
          editDistance(token, word, allowed) <= allowed ||
          editDistance(token, word.slice(0, token.length), allowed) <= allowed,
      )
    ) {
      return 1;
    }
  }
  return 0;
}

/**
 * An object's score for an input: the sum, word by word, of the best match among
 * its fields. 0 as soon as a word matches nowhere. An empty input is worth 1:
 * everything matches, without order.
 */
export function matchScore(
  query: string,
  fields: ReadonlyArray<string | null | undefined>,
  /** Prose fields: exact text only, without typo tolerance. */
  prose: ReadonlyArray<string | null | undefined> = [],
): number {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return 1;
  const fold = (list: ReadonlyArray<string | null | undefined>) =>
    list.filter((field): field is string => Boolean(field)).map(foldText);
  const names = fold(fields);
  const texts = fold(prose);
  let total = 0;
  for (const token of tokens) {
    let best = 0;
    for (const field of names) best = Math.max(best, tokenScore(token, field, false));
    for (const field of texts) best = Math.max(best, tokenScore(token, field, true));
    if (best === 0) return 0;
    total += best;
  }
  return total;
}

/** The objects that match, from best to worst; the original order breaks ties. */
export function rankByMatch<T>(
  query: string,
  items: readonly T[],
  fields: (item: T) => ReadonlyArray<string | null | undefined>,
  prose: (item: T) => ReadonlyArray<string | null | undefined> = () => [],
): T[] {
  return items
    .map((item, index) => ({ item, index, score: matchScore(query, fields(item), prose(item)) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);
}
