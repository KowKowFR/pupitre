import type { SsoSettings } from './settings.js';

/**
 * Ce que Pupitre fait d'un profil OpenID Connect, sans rien en savoir d'autre :
 * lire ses groupes, et en tirer un rôle.
 */

/** L'identifiant du fournisseur pour Better Auth : il entre dans l'URL de retour. */
export const SSO_PROVIDER_ID = 'oidc';

/** L'URL de retour à déclarer chez le fournisseur, pour un panel servi à `baseUrl`. */
export function ssoCallbackUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/auth/callback/${SSO_PROVIDER_ID}`;
}

/** Le document de découverte d'un émetteur. */
export function ssoDiscoveryUrl(issuer: string): string {
  return `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
}

/** Les portées, dédoublonnées, `openid` toujours en tête : sans elle, pas d'OpenID Connect. */
export function ssoScopes(scopes: string): string[] {
  const list = scopes.split(/\s+/).filter(Boolean);
  return ['openid', ...new Set(list.filter((scope) => scope !== 'openid'))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Les valeurs d'un champ du profil, par son chemin pointé : `groups`, ou
 * `realm_access.roles` pour les rôles de realm de Keycloak. Une chaîne seule
 * compte pour une valeur ; tout le reste est ignoré.
 */
export function claimValues(profile: unknown, path: string): string[] {
  let current: unknown = profile;
  for (const part of path.split('.')) {
    if (!isRecord(current)) return [];
    current = current[part];
  }
  if (typeof current === 'string') return [current];
  if (Array.isArray(current))
    return current.filter((value): value is string => typeof value === 'string');
  return [];
}

/** Keycloak écrit un groupe en chemin complet (`/ops/prod`) ou en nom seul : on compare sans le `/` de tête. */
function normalizeGroup(group: string): string {
  return group.trim().replace(/^\/+/, '');
}

/**
 * Le rôle que donnent les groupes : la **première** correspondance de la liste,
 * dans l'ordre où l'administrateur l'a écrite — c'est ce qui permet de faire
 * passer « admins » avant « ops ». Sans correspondance, le rôle par défaut.
 */
export function roleFromGroups(
  groups: readonly string[],
  settings: Pick<SsoSettings, 'roleMappings' | 'defaultRole'>,
): { role: string; matched: string | null } {
  const held = new Set(groups.map(normalizeGroup));
  for (const mapping of settings.roleMappings) {
    if (held.has(normalizeGroup(mapping.group)))
      return { role: mapping.role, matched: mapping.group };
  }
  return { role: settings.defaultRole, matched: null };
}
