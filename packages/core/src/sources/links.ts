import type { SourceProviderKind } from './types.js';

/**
 * Les adresses d'un dépôt côté navigateur, fournisseur par fournisseur.
 *
 * Module pur : l'écran s'en sert pour un lien vers un commit ou une branche,
 * le panel pour recopier l'adresse d'un dépôt dans un déploiement. Un dépôt
 * s'ouvre à `{base}/{propriétaire}/{nom}` partout — chez GitLab, avec tout le
 * chemin de ses groupes ; seules les pages d'une branche et d'un commit
 * diffèrent.
 */

export const GITHUB_WEB_URL = 'https://github.com';

/** Le nom d'un fournisseur, tel qu'on l'écrit partout — un nom propre, qui ne se traduit pas. */
export const SOURCE_PROVIDER_LABELS: Record<SourceProviderKind, string> = {
  github: 'GitHub',
  gitea: 'Gitea',
  gitlab: 'GitLab',
};

/**
 * L'adresse web d'une forge GitHub : github.com, ou celle d'un GitHub
 * Enterprise, déduite de son API (`https://ghe.exemple.fr/api/v3`).
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
 * La page d'un commit. Sans fournisseur connu — le run d'une liaison disparue —,
 * `/commit/` : GitHub et Gitea l'ouvrent, GitLab redirige vers `/-/commit/`.
 */
export function commitWebUrl(
  repositoryUrl: string,
  sha: string,
  provider?: SourceProviderKind,
): string {
  return `${repositoryUrl}/${provider === 'gitlab' ? '-/commit' : 'commit'}/${sha}`;
}
