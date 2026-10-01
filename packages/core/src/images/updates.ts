import { z } from 'zod';
import type { AppSpec } from '../spec/index.js';
import { parseImageReference, type ImageReference } from './reference.js';

/**
 * Les mises à jour d'images d'une application déployée.
 *
 * Deux constats, indépendants :
 *
 *   - **le tag a bougé** : `postgres:16` désigne aujourd'hui un autre contenu
 *     que celui qui tourne — une reconstruction pour un correctif de sécurité,
 *     typiquement. Un redéploiement le récupère, rien d'autre ne change ;
 *   - **un tag plus récent existe** : `postgres:16.4` tourne, `16.6` est
 *     publié. Changer de tag est une modification de l'AppSpec, donc une
 *     décision humaine — le panel la signale, il ne la prend pas.
 *
 * Ce qui n'est pas vérifié : les images construites sur la cible (pas de
 * registre, voir CLAUDE.md), et celles épinglées par digest, qui ne bougent
 * pas par construction.
 */

export const imageUpdateStatusSchema = z.enum(['current', 'outdated', 'unknown', 'pinned']);
export type ImageUpdateStatus = z.infer<typeof imageUpdateStatusSchema>;

/** Ce qu'un runtime rapporte d'un service en marche. */
export type RunningImage = {
  service: string;
  /** Digests des conteneurs ou pods du service — plusieurs pendant un rollout. */
  digests: string[];
};

export type CheckableImage = {
  service: string;
  /** La référence telle qu'écrite dans l'AppSpec. */
  image: string;
  ref: ImageReference;
};

/** Les services dont l'image vient d'un registre — les seuls qu'on sait vérifier. */
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
 * À jour si **tout** ce qui tourne est le contenu actuel du tag. Un rollout à
 * moitié fait n'est pas à jour, et rien qui tourne ne permet pas de conclure.
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

// ─── tags plus récents ────────────────────────────────────────────────────────

type Version = { prefix: string; numbers: number[]; suffix: string };

/**
 * `1.27.3-alpine` → `{ numbers: [1, 27, 3], suffix: '-alpine' }`. Un tag sans
 * numéro (`latest`, `stable`, `bookworm`) ne se compare à rien : `null`.
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
  /** Le plus récent de la même série majeure : `16.4` → `16.6`. */
  sameSeries: string | null;
  /** La plus récente des majeures suivantes : `16.4` → `17.2`. Une migration, pas un correctif. */
  nextMajor: string | null;
};

/**
 * Les tags plus récents **de même forme** : même nombre de composantes, même
 * préfixe `v`, même suffixe. `1.27-alpine` ne se compare qu'aux `x.y-alpine` ;
 * un `-rc1` n'est proposé qu'à qui suit déjà des `-rc1`. C'est ce qui évite de
 * proposer `17-bookworm` à qui tourne sur `16.4-alpine`.
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
 * Ce qui, dans un constat, mérite d'être annoncé une fois et pas deux : le
 * contenu nouveau du tag, ou le nouveau tag de la série. Un constat inchangé au
 * passage suivant produit la même clé — et donc aucun second message.
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
