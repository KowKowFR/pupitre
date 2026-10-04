import { z } from 'zod';

/**
 * Incident screenshots — the vocabulary, the bounds, the trade-offs.
 *
 * ── What the text does not say ──────────────────────────────────────────────
 * A probe that opens an incident writes a cause and a detail: "code 503, 200
 * expected", "connection refused". It is accurate and it is not enough. At three
 * in the morning, "code 503" does not say whether the page was blank, whether it
 * showed a database error, or whether the site had been replaced. Worse: a site
 * that returns **200** with a broken checkout flow, a maintenance page or a
 * defacement is down for its visitors and green for the probe. No metric catches
 * that case; an image does.
 *
 * ── What it is not ──────────────────────────────────────────────────────────
 * **Not a probe type.** The catalog describes what is observed (HTTP, TLS,
 * DNS…); the capture is a capability **attached to incidents**, orthogonal to
 * the type. Any probe whose target opens in a browser — exactly what the
 * catalog's `linkFor()` says — can produce one. A type added tomorrow inherits
 * it without writing anything here.
 *
 * ── This module is pure ─────────────────────────────────────────────────────
 * It is imported by client components. No native module, no network: the
 * browser is driven from `@pupitre/core/capture`, which only the worker loads.
 */

// ─── when to capture ──────────────────────────────────────────────────────────

/**
 * Three moments, and **only** three. Capturing at each query is out of the
 * question: a probe every minute would produce 1,440 images a day per site, to
 * show the same page 1,439 times.
 *
 *   reference          "here is what the site looks like when all is well".
 *                      Taken while the probe is healthy, at most once per
 *                      `MONITOR_CAPTURE_REFERENCE_EVERY_HOURS`. It is the
 *                      "before" half of the comparison, and without it the
 *                      incident image compares to nothing: we would not know
 *                      whether that red banner is new.
 *   incident_open      the page when the incident is confirmed. The feature's
 *                      reason for being.
 *   incident_resolved  the page at recovery. It costs one image per incident and
 *                      answers the question that always follows the first —
 *                      "is it really back, or is it the maintenance page
 *                      answering 200?". A recovery alert without proof forces a
 *                      manual check, which is precisely what we wanted to avoid.
 */
export const CAPTURE_KINDS = ['reference', 'incident_open', 'incident_resolved'] as const;
export const captureKindSchema = z.enum(CAPTURE_KINDS);
export type CaptureKind = z.infer<typeof captureKindSchema>;

// The labels of each moment, and those of the failures, lived here and no
// longer had a reader: the captures screen writes its own, under the `capture.*`
// keys of its own dictionary, hence in the instance's language.

/**
 * Reference rate: **6 hours**.
 *
 * The cost does not come from the rate but from retention, and there is only
 * ever **one** live reference per probe — a partial unique constraint in the
 * database guarantees it, it is not an `if`. Six hours is therefore simply "an
 * image fresh enough for the comparison to be honest", without harassing sites
 * that are fine.
 */
export const MONITOR_CAPTURE_REFERENCE_EVERY_HOURS = 6;

/** References refreshed per pass. Bounds a single sweep's work. */
export const MONITOR_CAPTURE_REFERENCE_BATCH = 5;

/** The references sweep does not start again more often than this. */
export const MONITOR_CAPTURE_REFERENCE_SWEEP_EVERY_SECONDS = 300;

// ─── format and weight ────────────────────────────────────────────────────────

/**
 * 1280 × 800: an ordinary desktop screen. Neither mobile — we monitor sites
 * whose desktop version we know — nor 4K, which would quadruple the weight to
 * show the same thing.
 */
export const MONITOR_CAPTURE_WIDTH = 1280;
export const MONITOR_CAPTURE_VIEWPORT_HEIGHT = 800;

/**
 * Maximum height rendered: **2,400 px**, that is three screens.
 *
 * Full height is a trap: a blog page is 20,000 px, weighs several megabytes as
 * PNG, and the bottom 19,000 px say nothing the first ones did not. What
 * diagnoses an outage is at the top. The capture notes when it truncated
 * (`truncated`): better to say it than hide it.
 */
export const MONITOR_CAPTURE_MAX_HEIGHT = 2_400;

/**
 * **JPEG, not PNG.** A full-height page as PNG weighs 3 to 8 MB; the same as JPEG
 * at quality 70 weighs 100 to 400 KB, for an invisible loss on what we come
 * looking for (was the page blank, broken, replaced?). Text stays perfectly
 * readable at this quality and at this scale.
 *
 * PNG would have one advantage — perfectly sharp text — which is not worth a
 * factor of twenty on data stored forever next to incidents that are never
 * purged.
 */
export const MONITOR_CAPTURE_FORMAT = 'jpeg' as const;
export const MONITOR_CAPTURE_QUALITY = 70;

/** Second, leaner attempt, when the first exceeds the hard cap. */
export const MONITOR_CAPTURE_FALLBACK_QUALITY = 40;
export const MONITOR_CAPTURE_FALLBACK_HEIGHT = 1_000;

/**
 * **Hard cap: 1.5 MB.** Beyond it, the image is dropped with its reason rather
 * than stored. A soft cap ("we try to stay small") is not a cap: a single
 * pathological page is enough for a `bytea` column to swallow the backup. The
 * normal path produces 100 to 400 KB; 1.5 MB is the accident.
 */
export const MONITOR_CAPTURE_MAX_BYTES = 1_500_000;

// ─── temps ────────────────────────────────────────────────────────────────────

/** A capture's total budget, browser connection included. */
export const MONITOR_CAPTURE_BUDGET_MS = 25_000;
/** Wait for the `load` event before shooting anyway. */
export const MONITOR_CAPTURE_LOAD_TIMEOUT_MS = 12_000;
/** Respite after `load`: time for fonts and hydration to settle. */
export const MONITOR_CAPTURE_SETTLE_MS = 700;

// ─── retention ────────────────────────────────────────────────────────────────

/**
 * **90 days for the bytes; the row never goes.**
 *
 * Incidents are never purged — they tell the story — but their images are: a
 * probe on its last legs produces three images per incident, and one incident a
 * day for a year is a quarter of a gigabyte for a single site. Beyond three
 * months, a capture no longer helps diagnose, it documents.
 *
 * What is purged is therefore the byte, not the fact: the row stays, with its
 * date, its size and its verdict, and the screen says "image purged on …". A
 * truncated timeline would lie; a timeline that says what it lost does not.
 */
export const MONITOR_CAPTURE_RETENTION_DAYS = 90;

// ─── a capture's result ───────────────────────────────────────────────────────

/**
 * A failed capture **is not an error**.
 *
 * It is the module's most important rule. The browser can be off, absent,
 * saturated, or the page may never finish loading: in every case the probe has
 * already given its verdict, the incident is already open and the alert has
 * already gone out. A capture is an **extra**, never a condition. Hence a result
 * with two branches rather than an exception, and a readable reason in the
 * losing branch.
 */
export type CaptureFailureReason =
  | 'browser-unavailable'
  | 'navigation-failed'
  | 'timeout'
  | 'too-large'
  | 'blocked'
  | 'not-capturable';

export type CaptureImage = {
  data: Uint8Array;
  format: typeof MONITOR_CAPTURE_FORMAT;
  width: number;
  height: number;
  /** The page was taller than `MONITOR_CAPTURE_MAX_HEIGHT`. */
  truncated: boolean;
  /** URL actually rendered, after redirects. */
  finalUrl: string;
  /** Code of the main response, when the browser saw it go by. */
  httpStatus: number | null;
  pageTitle: string | null;
  /** Total time, from navigation to the image. */
  elapsedMs: number;
};

export type CaptureOutcome =
  | { ok: true; image: CaptureImage }
  | { ok: false; reason: CaptureFailureReason; detail: string };

/** Is a capture due for this probe? Pure, hence testable. */
export function referenceIsDue(lastReferenceAt: Date | null, now: Date = new Date()): boolean {
  if (lastReferenceAt === null) return true;
  const ageMs = now.getTime() - lastReferenceAt.getTime();
  return ageMs >= MONITOR_CAPTURE_REFERENCE_EVERY_HOURS * 3_600_000;
}

/**
 * Decides the rendered height from the page's real height.
 *
 * Bounded at the bottom too: a page that declares itself 0 px high (failed
 * render, empty body) must still produce an image — "the page was blank" is
 * precisely one of the diagnoses we come looking for.
 */
export function captureHeightFor(
  contentHeight: number,
  maxHeight: number = MONITOR_CAPTURE_MAX_HEIGHT,
): { height: number; truncated: boolean } {
  const wanted = Math.ceil(Number.isFinite(contentHeight) ? contentHeight : 0);
  if (wanted <= 0) return { height: MONITOR_CAPTURE_VIEWPORT_HEIGHT, truncated: false };
  if (wanted > maxHeight) return { height: maxHeight, truncated: true };
  return { height: Math.max(wanted, 200), truncated: false };
}

/**
 * What is written next to an image, and what is not.
 *
 * ⚠ **A capture can contain anything the page shows.** The browser is blank — a
 * new context for each capture, no cookie, no session — so it sees what an
 * anonymous visitor would see: a page behind authentication renders its sign-in
 * screen, not the private content. There remains the case of the URL that
 * **carries** the secret (`?token=…`): there, the browser renders the private
 * content, and the image shows it.
 *
 * What is done about this risk, explicitly:
 *   — the monitored URL is already readable by anyone with `monitor:read` (it is
 *     in `config`): the capture does not open an access, it makes visible what
 *     that access already allowed;
 *   — the image is only served to `monitor:read`, never published, never
 *     attached to an alert, never sent to a webhook or a notification channel;
 *   — the feature is **optional and off by default**: without
 *     `MONITOR_CAPTURE_CDP_URL`, no image is taken;
 *   — the URL fragment (`#…`) is not passed to the browser — it is useless for
 *     server rendering and would end up copied in clear into the table.
 */
export function captureUrlFor(link: string): string | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  return url.toString();
}
