import type { SourceProviderKind } from './types.js';

/**
 * A repository's browser-side addresses, provider by provider.
 *
 * A pure module: the screen uses it for a link to a commit or a branch, the
 * panel to copy a repository's address into a deployment. A repository opens at
 * `{base}/{owner}/{name}` everywhere — at GitLab, with the whole path of its
 * groups; only a branch's and a commit's pages differ.
 */

export const GITHUB_WEB_URL = 'https://github.com';

/** A provider's name, as written everywhere — a proper noun, not translated. */
export const SOURCE_PROVIDER_LABELS: Record<SourceProviderKind, string> = {
  github: 'GitHub',
  gitea: 'Gitea',
  gitlab: 'GitLab',
};

/**
 * The web address of a GitHub forge: github.com, or a GitHub Enterprise's,
 * inferred from its API (`https://ghe.example.com/api/v3`).
 */
export function githubWebUrl(apiUrl: string | null): string {
  if (!apiUrl) return GITHUB_WEB_URL;
  try {
    const url = new URL(apiUrl);
    if (url.hostname === 'api.github.com') return GITHUB_WEB_URL;
    return `${url.origin}${url.pathname.replace(/\/api\/v3\/?$/, '').replace(/\/+$/, '')}`;
  } catch {
    return GITHUB_WEB_URL;
  }
}

export function repositoryWebUrl(base: string, fullName: string): string {
  return `${base.replace(/\/+$/, '')}/${fullName}`;
}

export function branchWebUrl(
  provider: SourceProviderKind,
  repositoryUrl: string,
  branch: string,
): string {
  const segment = provider === 'gitea' ? 'src/branch' : provider === 'gitlab' ? '-/tree' : 'tree';
  return `${repositoryUrl}/${segment}/${encodeURIComponent(branch)}`;
}

/**
 * A commit's page. Without a known provider — the run of a link that is gone —,
 * `/commit/`: GitHub and Gitea open it, GitLab redirects to `/-/commit/`.
 */
export function commitWebUrl(
  repositoryUrl: string,
  sha: string,
  provider?: SourceProviderKind,
): string {
  return `${repositoryUrl}/${provider === 'gitlab' ? '-/commit' : 'commit'}/${sha}`;
}
