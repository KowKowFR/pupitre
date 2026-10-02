/**
 * Les adresses d'un dépôt lié côté navigateur. GitHub est le seul fournisseur
 * pour l'instant : le jour où un second arrive, c'est ici qu'il se branche,
 * pas dans chaque écran qui montre un commit.
 */
const GITHUB_WEB = 'https://github.com';

export type CommitSource = { repository: string; ref: string | null; sha: string };

function repositoryHref(repository: string): string {
  return `${GITHUB_WEB}/${repository}`;
}

export function branchHref(repository: string, branch: string): string {
  return `${repositoryHref(repository)}/tree/${encodeURIComponent(branch)}`;
}

export function commitHref(repository: string, sha: string): string {
  return `${repositoryHref(repository)}/commit/${sha}`;
}

/** Le commit d'un run, s'il vient d'un dépôt lié. */
export function commitSourceOf(row: {
  sourceRepository: string | null;
  sourceRef: string | null;
  sourceSha: string | null;
}): CommitSource | null {
  if (!row.sourceRepository || !row.sourceSha) return null;
  return { repository: row.sourceRepository, ref: row.sourceRef, sha: row.sourceSha };
}
