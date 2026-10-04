import { z } from 'zod';
import type { AppSpec } from '../spec/index.js';
import { parseImageReference, type ImageReference } from './reference.js';

/**
 * Image updates of a deployed application.
 *
 * Two findings, independent:
 *
 *   - **the tag moved**: `postgres:16` designates other content today than what
 *     runs — a rebuild for a security fix, typically. A redeploy picks it up,
 *     nothing else changes;
 *   - **a more recent tag exists**: `postgres:16.4` runs, `16.6` is published.
 *     Changing tag is a change to the AppSpec, hence a human decision — the
 *     panel reports it, it does not make it.
 *
 * What is not checked: images built on the target (no registry, see CLAUDE.md),
 * and those pinned by digest, which do not move by construction.
 */

export const imageUpdateStatusSchema = z.enum(['current', 'outdated', 'unknown', 'pinned']);
export type ImageUpdateStatus = z.infer<typeof imageUpdateStatusSchema>;

/** What a runtime reports about a running service. */
export type RunningImage = {
  service: string;
  /** Digests of the service's containers or pods — several during a rollout. */
  digests: string[];
};

export type CheckableImage = {
  service: string;
  /** The reference as written in the AppSpec. */
  image: string;
  ref: ImageReference;
};

/** The services whose image comes from a registry — the only ones we can check. */
export function checkableImages(spec: AppSpec): CheckableImage[] {
  const images: CheckableImage[] = [];
  for (const service of spec.services) {
    if (service.source.type !== 'image') continue;
    const ref = parseImageReference(service.source.ref);
    if (ref) images.push({ service: service.name, image: service.source.ref, ref });
  }
  return images;
}

/**
 * Up to date if **everything** running is the tag's current content. A
 * half-done rollout is not up to date, and nothing running does not allow a
 * conclusion.
 */
export function judgeImage(input: {
  pinned: boolean;
  running: string[];
  latest: string | null;
}): ImageUpdateStatus {
  if (input.pinned) return 'pinned';
  if (!input.latest || input.running.length === 0) return 'unknown';
  return input.running.every((digest) => digest === input.latest) ? 'current' : 'outdated';
}

// ─── more recent tags ─────────────────────────────────────────────────────────

type Version = { prefix: string; numbers: number[]; suffix: string };

/**
 * `1.27.3-alpine` → `{ numbers: [1, 27, 3], suffix: '-alpine' }`. A tag without
 * a number (`latest`, `stable`, `bookworm`) compares to nothing: `null`.
 */
export function parseVersionTag(tag: string): Version | null {
  const match = /^(v?)(\d{1,9})(?:\.(\d{1,9}))?(?:\.(\d{1,9}))?([-_+][\w.+-]*)?$/.exec(tag);
  if (!match) return null;
  const numbers = [match[2], match[3], match[4]]
    .filter((part): part is string => part !== undefined)
    .map(Number);
  return { prefix: match[1] ?? '', numbers, suffix: match[5] ?? '' };
}

function compare(a: number[], b: number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export type NewerTags = {
  /** The most recent of the same major series: `16.4` → `16.6`. */
  sameSeries: string | null;
  /** The most recent of the following majors: `16.4` → `17.2`. A migration, not a fix. */
  nextMajor: string | null;
};

/**
 * The more recent tags **of the same shape**: same number of components, same
 * `v` prefix, same suffix. `1.27-alpine` only compares to `x.y-alpine`; an
 * `-rc1` is only offered to whoever already follows `-rc1`s. That is what avoids
 * offering `17-bookworm` to whoever runs `16.4-alpine`.
 */
export function newerTags(current: string, tags: readonly string[]): NewerTags {
  const base = parseVersionTag(current);
  if (!base) return { sameSeries: null, nextMajor: null };

  let sameSeries: { tag: string; numbers: number[] } | null = null;
  let nextMajor: { tag: string; numbers: number[] } | null = null;
  for (const tag of tags) {
    const version = parseVersionTag(tag);
    if (
      !version ||
      version.prefix !== base.prefix ||
      version.suffix !== base.suffix ||
      version.numbers.length !== base.numbers.length ||
      compare(version.numbers, base.numbers) <= 0
    ) {
      continue;
    }
    const sameMajor = version.numbers[0] === base.numbers[0];
    if (sameMajor && base.numbers.length > 1) {
      if (!sameSeries || compare(version.numbers, sameSeries.numbers) > 0) {
        sameSeries = { tag, numbers: version.numbers };
      }
    } else if (!sameMajor) {
      if (!nextMajor || compare(version.numbers, nextMajor.numbers) > 0) {
        nextMajor = { tag, numbers: version.numbers };
      }
    }
  }
  return { sameSeries: sameSeries?.tag ?? null, nextMajor: nextMajor?.tag ?? null };
}

/**
 * What, in a finding, deserves to be announced once and not twice: the tag's new
 * content, or the series' new tag. A finding unchanged at the next pass produces
 * the same key — and hence no second message.
 */
export function updateNoticeKey(input: {
  status: ImageUpdateStatus;
  latestDigest: string | null;
  sameSeries: string | null;
}): string | null {
  const parts = [
    input.status === 'outdated' ? input.latestDigest : null,
    input.sameSeries ? `tag:${input.sameSeries}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join('|') : null;
}
