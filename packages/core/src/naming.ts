/**
 * The name under which an application is grouped on a target machine: Compose
 * project on the Docker side, namespace on the K3s side. CLAUDE.md convention —
 * `app-{slug}` — and it is the **same** for both runtimes.
 *
 * ── Why this function is at the root of `@pupitre/core` ─────────────────────
 * The authority stays the driver: `DeploymentDriver.workspaceName()` is what the
 * worker queries, and a future driver could legitimately name differently. But
 * the Next panel cannot call a driver — `@pupitre/core/drivers` is deliberately
 * outside its graph so that `ssh2` does not get in —, and the confirmation
 * screen must nevertheless **name** the Compose project a forced action would
 * abandon. Without this common point, it would have rebuilt it by hand, and the
 * hard-coded `'app-'` would have ended up in TSX.
 *
 * Both drivers derive their own prefixes from it: there is only one definition
 * of the convention, here, and two vocabularies that reuse it. Nothing in this
 * file runs anything — the same rule as `ports.ts` and `scan.ts`.
 */
export const WORKSPACE_PREFIX = 'app-';

export function workspaceNameFor(appSlug: string): string {
  return `${WORKSPACE_PREFIX}${appSlug}`;
}
