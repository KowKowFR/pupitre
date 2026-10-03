import type { SourceProviderKind } from './types.js';

/**
 * Les adresses d'un dépôt côté navigateur, fournisseur par fournisseur.
 *
 * Module pur : l'écran s'en sert pour un lien vers un commit ou une branche,
 * le panel pour recopier l'adresse d'un dépôt dans un déploiement. Un dépôt
 * s'ouvre à `{base}/{propriétaire}/{nom}` partout ; seule la page d'une
 * branche diffère.
 */

export const GITHUB_WEB_URL = 'https://github.com';

/** Le nom d'un fournisseur, tel qu'on l'écrit partout — un nom propre, qui ne se traduit pas. */
export const SOURCE_PROVIDER_LABELS: Record<SourceProviderKind, string> = {
  github: 'GitHub',
  gitea: 'Gitea',
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
  const segment = provider === 'gitea' ? 'src/branch' : 'tree';
  return `${repositoryUrl}/${segment}/${encodeURIComponent(branch)}`;
}

export function commitWebUrl(repositoryUrl: string, sha: string): string {
  return `${repositoryUrl}/commit/${sha}`;
}
