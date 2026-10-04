/**
 * A confirmation matching the risk — the design system's three levels.
 *
 *   1. `reversible`: stop, restart, pause. A short dialog, the verb as primary.
 *   2. `trace`: purge a history, delete an empty object. Consequences listed, an
 *      outlined destructive button.
 *   3. `data`: destroy an app on its target, delete a live app, force the
 *      erasure. One must **type the name again**; the full red button stays
 *      disabled as long as the input does not match exactly.
 *
 * This module is pure: it serves the dialog and the tests.
 */

export type ConfirmLevel = 'reversible' | 'trace' | 'data';

/**
 * Does the input unlock the confirmation? An exact match, case included: `Blog`
 * does not unlock `blog`. Only leading and trailing blanks are tolerated, because
 * a copy and paste often brings one along.
 */
export function confirmMatches(typed: string, expected: string): boolean {
  return expected.length > 0 && typed.trim() === expected;
}

/** The final verb takes the level's variant. */
export function confirmVariant(
  level: ConfirmLevel,
): 'default' | 'destructive' | 'destructive-solid' {
  if (level === 'data') return 'destructive-solid';
  if (level === 'trace') return 'destructive';
  return 'default';
}
