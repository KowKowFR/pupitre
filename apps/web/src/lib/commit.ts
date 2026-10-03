import { GITHUB_WEB_URL, commitWebUrl, repositoryWebUrl } from '@pupitre/core';

/**
 * Le commit d'un run, côté navigateur. Le déploiement garde l'adresse web de
 * son dépôt (`source_url`), recopiée de sa forge — GitHub, GitLab ou Gitea —
 * au moment du run : le lien vers le commit en découle, même si la liaison a
 * disparu depuis. Un run d'avant cette adresse vient forcément de GitHub.
 */
export type CommitSource = {
  repository: string;
  ref: string | null;
  sha: string;
  /** L'adresse web du dépôt chez sa forge. */
  url: string | null;
};

export function commitHrefOf(source: CommitSource): string {
  return commitWebUrl(
    source.url ?? repositoryWebUrl(GITHUB_WEB_URL, source.repository),
    source.sha,
  );
}

/** Le commit d'un run, s'il vient d'un dépôt lié. */
export function commitSourceOf(row: {
  sourceRepository: string | null;
  sourceRef: string | null;
  sourceSha: string | null;
  sourceUrl: string | null;
}): CommitSource | null {
  if (!row.sourceRepository || !row.sourceSha) return null;
  return {
    repository: row.sourceRepository,
    ref: row.sourceRef,
    sha: row.sourceSha,
    url: row.sourceUrl,
  };
}
