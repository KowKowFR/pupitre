/**
 * Le nom sous lequel une application est regroupée sur une machine cible :
 * projet Compose côté Docker, namespace côté K3s. Convention CLAUDE.md —
 * `app-{slug}` — et c'est la **même** pour les deux runtimes.
 *
 * ── Pourquoi cette fonction est à la racine de `@pupitre/core` ─────────────────────
 * L'autorité reste le driver : `DeploymentDriver.workspaceName()` est ce que le
 * worker interroge, et un driver futur pourrait légitimement nommer autrement.
 * Mais le panel Next ne peut pas appeler un driver — `@pupitre/core/drivers` est
 * délibérément hors de son graphe pour que `ssh2` n'y entre pas —, et l'écran
 * de confirmation doit pourtant **nommer** le projet Compose qu'un forçage
 * abandonnerait. Sans ce point commun, il l'aurait recomposé à la main, et le
 * `'app-'` en dur se serait retrouvé dans du TSX.
 *
 * Les deux drivers en dérivent leurs propres préfixes : il n'y a qu'une
 * définition de la convention, ici, et deux vocabulaires qui la reprennent.
 * Rien n'exécute quoi que ce soit dans ce fichier — même règle que `ports.ts`
 * et `scan.ts`.
 */
export const WORKSPACE_PREFIX = 'app-';

export function workspaceNameFor(appSlug: string): string {
  return `${WORKSPACE_PREFIX}${appSlug}`;
}
