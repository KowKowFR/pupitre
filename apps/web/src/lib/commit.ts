import { GITHUB_WEB_URL, commitWebUrl, repositoryWebUrl } from '@pupitre/core';

/**
 * A run's commit, browser side. The deployment keeps its repository's web
 * address (`source_url`), copied from its forge — GitHub, GitLab or Gitea — at the
 * time of the run: the link to the commit follows from it, even if the link has
 * disappeared since. A run from before this address necessarily comes from
 * GitHub.
 */
export type CommitSource = {
  repository: string;
  ref: string | null;
  sha: string;
  /** The repository's web address at its forge. */
  url: string | null;
};

export function commitHrefOf(source: CommitSource): string {
  return commitWebUrl(
    source.url ?? repositoryWebUrl(GITHUB_WEB_URL, source.repository),
    source.sha,
  );
}

/** A run's commit, if it comes from a linked repository. */
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
