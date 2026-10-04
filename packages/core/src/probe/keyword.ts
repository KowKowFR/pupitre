import {
  keywordConfigSchema,
  type KeywordConfig,
  type KeywordMatching,
  type KeywordScope,
} from '../monitors/catalog.js';
import type { Cidr } from '../monitors/ssrf.js';
import type { CheckResult } from '../monitors/state.js';
import { certificateMetrics, decodeBody, guardedFetch } from './fetch.js';
import type { UiLanguage } from '../i18n.js';
import { probeSay } from './messages.js';
import type { MonitorProbe, ProbeContext } from './types.js';

/**
 * Keyword probe — "does the page say what it must say?"
 *
 * An HTTP probe that returns 200 proves that *something* listens. It does not
 * prove the application works: an application error page, a maintenance screen
 * and a defaced site return 200 with the same eagerness. The keyword is the
 * boundary between "the server answers" and "the application answers".
 *
 * ── The three trade-offs ────────────────────────────────────────────────────
 *
 * 1. **Presence and absence.** See `keywordConfigSchema`: two real and
 *    opposite needs, served by the same request.
 *
 * 2. **What we search.** By default the response *as it arrived*. It is the only
 *    text we can assert is really the one that was served. Searching the
 *    "visible text" would assume an HTML parser: one more dependency in a
 *    package that has none, and a parser that gets it wrong turns a healthy site
 *    into a false outage. The `text` mode exists anyway — it is mostly useful for
 *    a *forbidden text*, which a comment or an attribute would wrongly trigger —
 *    but it is announced for what it is: stripping by regular expressions, not a
 *    parser. It claims nothing more, neither in the code nor on screen.
 *
 * 3. **Case, accents, spaces.** Lenient mode is the default, because the 3 a.m.
 *    false positive is the real danger: a keyword that fails on a no-break space
 *    or an uppercase letter teaches on-call to ignore alerts. Strict mode stays
 *    available for whoever monitors an exact token rather than a sentence.
 *
 * ── What it does not do ─────────────────────────────────────────────────────
 * It does not run JavaScript. On an application entirely rendered by the
 * browser, the served body often contains nothing but a `<div id="root">`: the
 * keyword will be absent, and it will not be a lie from the probe but a
 * property of the page. It is written in `neverDoes`.
 */

// ─── normalisation ────────────────────────────────────────────────────────────

/** All Unicode spaces, including the no-break and the narrow no-break space. */
const ANY_SPACE = /\s+/gu;
/** Combining marks, what remains of accents after NFD decomposition. */
const COMBINING = /\p{M}+/gu;

/**
 * The text as compared in lenient mode.
 *
 * Order matters. NFKC first: it is what brings the no-break space (U+00A0), the
 * narrow space (U+202F) and ligatures back to their ordinary form. Then case,
 * then NFD + removing marks for accents, then squashing runs of spaces — a line
 * break in the HTML in the middle of "Sign  in" must not count as a difference.
 *
 * The same function is applied to the searched text **and** to the text
 * searched in: it is the only way for the comparison to be symmetric.
 */
export function foldForSearch(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(COMBINING, '')
    .replace(ANY_SPACE, ' ')
    .trim();
}

const SCRIPT_OR_STYLE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const COMMENT = /<!--[\s\S]*?-->/g;
const TAG = /<\/?[a-z][^>]*>/gi;
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * Removes tags — **an accepted approximation**, not a parser.
 *
 * It gets it wrong on a literal `<` in text, on a `>` in an attribute value, on
 * CDATA. These cases exist and they are rare; what is much less rare is "Error
 * 500" in an HTML comment or in an `alt`, which would trigger a forbidden text
 * no visitor ever read. The choice is offered, not imposed: the default mode
 * stays the raw response.
 *
 * `<script>` and `<style>` blocks go first, with their content: a modern
 * application's hydration JSON contains just about every word of the page,
 * including those it does not show.
 */
export function stripMarkup(html: string): string {
  return html
    .replace(SCRIPT_OR_STYLE, ' ')
    .replace(COMMENT, ' ')
    .replace(TAG, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
      const lower = body.toLowerCase();
      if (lower.startsWith('#x')) {
        const code = Number.parseInt(lower.slice(2), 16);
        return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
      }
      if (lower.startsWith('#')) {
        const code = Number.parseInt(lower.slice(1), 10);
        return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
      }
      return NAMED_ENTITIES[lower] ?? whole;
    });
}

/** The text we will search in, according to the requested scope. */
function haystackOf(body: string, scope: KeywordScope): string {
  return scope === 'text' ? stripMarkup(body) : body;
}

/** The search itself, without network — it is what the tests exercise. */
export function containsKeyword(
  haystack: string,
  needle: string,
  matching: KeywordMatching,
): boolean {
  if (matching === 'strict') return haystack.includes(needle);
  return foldForSearch(haystack).includes(foldForSearch(needle));
}

// ─── verdict ──────────────────────────────────────────────────────────────────

async function runKeyword(
  config: KeywordConfig,
  allowlist: readonly Cidr[],
  language: UiLanguage,
): Promise<CheckResult> {
  const say = probeSay(language);
  const maxBytes = config.maxKib * 1024;

  const result = await guardedFetch({
    url: config.url,
    // Always GET: looking for a word in a body we did not ask for makes no sense,
    // and HEAD returns none.
    method: 'GET',
    timeoutMs: config.timeoutMs,
    maxBytes,
    readBody: true,
    // The full SSRF guard, redirects included: `guardedFetch` resolves and checks
    // each hop again. The keyword probe has no loop of its own, hence no way of its
    // own to forget it.
    allowlist,
    language,
  });

  if (!result.ok) {
    const outcome = result.kind === 'redirect' ? 'unhealthy' : 'unreachable';
    return {
      outcome,
      latencyMs: result.status === null ? null : result.latencyMs,
      detail: result.detail,
      metrics: {
        httpStatus: result.status,
        latencyMs: result.status === null ? null : result.latencyMs,
        bytesRead: 0,
        truncated: say('no'),
        redirects: result.redirects,
        address: result.address,
        finalUrl: result.finalUrl,
      },
    };
  }

  const metrics = {
    httpStatus: result.status,
    latencyMs: result.latencyMs,
    bytesRead: result.body.byteLength,
    truncated: result.truncated ? say('yes') : say('no'),
    redirects: result.redirects,
    address: result.address,
    finalUrl: result.finalUrl,
    ...certificateMetrics(result.certificate),
  };

  const verdict = (outcome: 'healthy' | 'unhealthy', detail: string | null): CheckResult => ({
    outcome,
    latencyMs: result.latencyMs,
    detail,
    metrics,
  });

  if (result.status !== config.expectedStatus) {
    return verdict(
      'unhealthy',
      say('http.status', { status: result.status, expected: config.expectedStatus }),
    );
  }

  const body = decodeBody(result.body, result.headers['content-type']);
  const haystack = haystackOf(body, config.scope);
  // Truncation is always said, and never as an absence: "I did not find it" and
  // "I did not finish looking" are two different findings.
  const cut = result.truncated ? say('keyword.cut', { kib: config.maxKib }) : '';

  if (config.mustContain !== null && !containsKeyword(haystack, config.mustContain, config.matching)) {
    return verdict('unhealthy', say('keyword.missing', { text: config.mustContain, cut }));
  }

  if (
    config.mustNotContain !== null &&
    containsKeyword(haystack, config.mustNotContain, config.matching)
  ) {
    return verdict('unhealthy', say('keyword.forbidden', { text: config.mustNotContain }));
  }

  // Healthy, but not silent: if the response was cut, the absence of the
  // forbidden text is only established on what was read. Saying it in the detail
  // is better than suggesting a proof.
  const partial =
    result.truncated && config.mustNotContain !== null
      ? say('keyword.partial', { kib: config.maxKib })
      : null;

  return verdict('healthy', partial);
}

export const keywordProbe: MonitorProbe = {
  type: 'keyword',
  async run(config, ctx: ProbeContext): Promise<CheckResult> {
    const parsed = keywordConfigSchema.safeParse(config);
    if (!parsed.success) {
      return {
        outcome: 'unreachable',
        latencyMs: null,
        detail: probeSay(ctx.language)('invalidConfig', {
          issues: parsed.error.issues.map((issue) => issue.message).join(', '),
        }),
        metrics: {},
      };
    }
    return runKeyword(parsed.data, ctx.allowlist, ctx.language);
  },
};
