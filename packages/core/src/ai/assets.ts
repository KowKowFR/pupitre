import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAbsolute, resolve } from 'node:path';

/**
 * Reading `packages/core`'s versioned resources — the system prompt and the
 * AppSpec fixtures.
 *
 * The problem is subtler than it looks. These files are read from **three**
 * execution contexts that do not see the same tree:
 *
 *   1. the sources, under `tsx` (tests, scripts) — `src/ai/…`
 *   2. the compiled package, under Node (worker, Docker image) — `dist/ai/…`,
 *      where `tsc` copies neither the `.md` nor the `.json`: it is the `build`
 *      script of `packages/core` that copies them next to the emitted JavaScript
 *   3. the Next panel, where `@pupitre/core` is **inlined** into the server
 *      chunks. `import.meta.url` then designates a chunk of `.next/server`, and
 *      no module-relative resolution can succeed. Next does, however, copy the
 *      files declared in `outputFileTracingIncludes` preserving their path from
 *      the monorepo root, and its `standalone` server does a `process.chdir()`
 *      to `apps/web`: the file is therefore at a known position *relative to the
 *      current directory*.
 *
 * Hence a list of candidates rather than a single path.
 *
 * ── Why a content validation, and not only "the file exists" ───────────────
 * Turbopack **rewrites** `new URL(…, import.meta.url)` in the modules it
 * inlines. The path obtained at runtime no longer points to the requested
 * resource but to a module emitted in `.next/server/assets/`. The
 * `readFileSync` then succeeds perfectly — and returns a JavaScript module's
 * source code instead of the prompt. Observed, not assumed: the health probe
 * announced a 1,701-byte prompt where it is 9,966.
 *
 * A candidate is therefore only kept if its content **looks like what was
 * asked for**. Without that, the error is silent: the panel goes to production
 * with a system prompt that is a piece of TypeScript, and the model answers
 * nonsense without anything having failed.
 *
 * The complete failure names everything that was tried — a missing prompt in
 * production must be diagnosed by reading the message, not by digging into the
 * image.
 */

/** A resource's path, relative to `packages/core/src`. */
export type CoreAssetPath = `${string}/${string}`;

function candidatesFor(asset: CoreAssetPath): string[] {
  const candidates: string[] = [];

  // (1) and (2): next to the module, whether running from `src` or from `dist`.
  // `../` climbs from `ai/` to the root of the compiled package or the sources.
  try {
    candidates.push(fileURLToPath(new URL(`../${asset}`, import.meta.url)));
  } catch {
    // `import.meta.url` may not be a `file:` (bundler): we skip.
  }

  // (3): from the current directory. `apps/web` under `next dev` as under the
  // `standalone` server, or the monorepo root for a script.
  const cwd = process.cwd();
  candidates.push(
    resolve(cwd, '../../packages/core/src', asset),
    resolve(cwd, '../../packages/core/dist', asset),
    resolve(cwd, 'packages/core/src', asset),
    resolve(cwd, 'packages/core/dist', asset),
  );

  return candidates;
}

const cache = new Map<string, string>();

export type ReadAssetOptions = {
  /**
   * Recognizes the expected content. A candidate that fails is discarded as if it
   * did not exist, and the search goes on. **Mandatory in practice**: see the
   * explanation above about Turbopack's rewriting.
   */
  looksRight: (content: string) => boolean;
  /** Named in the error message, to say what we were looking for. */
  expectation: string;
};

/** Reads a versioned resource. The result is memoized: it does not change. */
export function readCoreAsset(asset: CoreAssetPath, options: ReadAssetOptions): string {
  // Memoization is keyed on the (resource, expectation) pair and not on the
  // resource alone: two callers that do not expect the same thing must not share
  // a result, otherwise the first — potentially lax — decides for the second what
  // is acceptable.
  const cacheKey = `${asset}\u0000${options.expectation}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const tried: string[] = [];
  const rejected: string[] = [];

  for (const candidate of candidatesFor(asset)) {
    if (!isAbsolute(candidate)) continue;
    tried.push(candidate);

    let content: string;
    try {
      content = readFileSync(candidate, 'utf8');
    } catch {
      continue; // next candidate
    }

    if (!options.looksRight(content)) {
      rejected.push(`${candidate} (read, but ${options.expectation} is missing)`);
      continue;
    }

    cache.set(cacheKey, content);
    return content;
  }

  const detail = [...rejected, ...tried.filter((path) => !rejected.some((r) => r.startsWith(path)))];
  throw new Error(
    `resource "${asset}" not found or unrecognizable in @pupitre/core ` +
      `(expected: ${options.expectation}). Paths tried:\n  ${detail.join('\n  ')}`,
  );
}
