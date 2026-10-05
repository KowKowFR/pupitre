/**
 * Wait between two health probes.
 *
 * `intervalSec` is doubled at each attempt, then capped. An application that
 * takes a minute to start does not need to be queried thirty times in thirty
 * seconds; one that answers right away must not wait a minute for nothing.
 * Without a cap, the fifth attempt would already wait sixteen times the
 * requested interval — the AppSpec's setting would no longer mean anything.
 *
 * Shared by both drivers: a probe's timing has nothing runtime-specific.
 */

/** Cap of the exponential backoff, in seconds. */
export const BACKOFF_CAP_SEC = 30;

export function backoffMs(intervalSec: number, attempt: number): number {
  const capped = Math.min(intervalSec * 2 ** (attempt - 1), BACKOFF_CAP_SEC);
  return Math.round(capped * 1000);
}
