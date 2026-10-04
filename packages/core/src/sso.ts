import type { SsoSettings } from './settings.js';

/**
 * What Pupitre does with an OpenID Connect profile, without knowing anything
 * else about it: read its groups, and draw a role from them.
 */

/** The provider's identifier for Better Auth: it goes into the callback URL. */
export const SSO_PROVIDER_ID = 'oidc';

/** The callback URL to declare at the provider, for a panel served at `baseUrl`. */
export function ssoCallbackUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/auth/callback/${SSO_PROVIDER_ID}`;
}

/** An issuer's discovery document. */
export function ssoDiscoveryUrl(issuer: string): string {
  return `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
}

/** The scopes, deduplicated, `openid` always first: without it, no OpenID Connect. */
export function ssoScopes(scopes: string): string[] {
  const list = scopes.split(/\s+/).filter(Boolean);
  return ['openid', ...new Set(list.filter((scope) => scope !== 'openid'))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The values of a profile field, by its dotted path: `groups`, or
 * `realm_access.roles` for Keycloak's realm roles — which it only puts in the ID
 * token if its mapper adds them. A lone string counts as one value; everything
 * else is ignored.
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

/**
 * Keycloak writes a group as a full path (`/ops/prod`) or a bare name: we compare
 * without the leading `/`.
 */
function normalizeGroup(group: string): string {
  return group.trim().replace(/^\/+/, '');
}

/**
 * The role the groups give: the **first** match of the list, in the order the
 * administrator wrote it — that is what allows putting "admins" before "ops".
 * Without a match, the default role.
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
