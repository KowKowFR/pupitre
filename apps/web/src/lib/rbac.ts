import 'server-only';
import { isPermission, requiresTwoFactor, type Permission, type RoleKey } from '@pupitre/core';
import {
  eq,
  findApiTokenByHash,
  getAppSettingsValue,
  getDb,
  getUserGrants,
  logAudit,
  sessions,
  touchApiToken,
} from '@pupitre/db';
import { bearerToken, hashApiToken } from './api-token-format';
import { getSession, hasPassword } from './auth';
import {
  AccountDisabledError,
  ApiTokenScopeError,
  ForbiddenError,
  InvalidApiTokenError,
  NoAccessError,
  TwoFactorRequiredError,
  UnauthenticatedError,
} from './errors';
import { clientIp } from './http';
import { sessionPolicy } from './session-policy';

/**
 * Access control. A single entry point: `requirePermission()`. No route compares a
 * role or a permission by hand.
 */

export type AuthContext = {
  userId: string;
  email: string;
  name: string;
  /** The versioned URL of their profile picture, or `null`. */
  image: string | null;
  roles: RoleKey[];
  permissions: Permission[];
  ip: string | null;
  /** A local test, without a new database query. */
  can: (permission: Permission) => boolean;
  /**
   * The API token that authenticates the request, `null` for a browser session.
   * `applications`: those it covers, `null` for all of them.
   */
  token: { id: string; name: string; applications: ReadonlySet<string> | null } | null;
  /**
   * The account's second factor, with regard to the instance's policy.
   * `mustEnroll`: required and absent — the account only has access to "My
   * account", the time to enable it: `can()` answers no to everything,
   * `permissions` says what its roles will give it.
   */
  twoFactor: { enabled: boolean; required: boolean; mustEnroll: boolean };
};

/**
 * The second factor required and absent. An account without a password — which
 * only comes in through single sign-on — is not bound by it: it could not enable
 * it (Better Auth asks for it with the password), and its protection is the
 * identity provider's business.
 */
async function twoFactorState(
  userId: string,
  permissions: readonly string[],
  enabled: boolean,
): Promise<AuthContext['twoFactor']> {
  const policy = (await getAppSettingsValue()).accounts.twoFactorPolicy;
  const required = requiresTwoFactor(permissions, policy);
  const mustEnroll = required && !enabled && (await hasPassword(userId));
  return { enabled, required, mustEnroll };
}

/**
 * A route that is only done from the panel received an API token: 403, said as
 * such — a 401 would make the CI believe its token is worthless.
 */
async function refuseApiToken(request: Request, resourceId: string | null): Promise<never> {
  await logAudit({
    action: 'permission.denied',
    resourceType: 'permission',
    resourceId,
    after: {
      reason: 'token_refused',
      method: request.method,
      path: new URL(request.url).pathname,
    },
    ip: clientIp(request),
  });
  throw new ApiTokenScopeError('sessionOnly');
}

/**
 * An authenticated browser session, without a permission check. 401 otherwise. An
 * API token does not stand in for it: what only requires a session — one's
 * account, one's password, the chat, one's tokens — is done from the panel.
 */
export async function requireSession(request: Request): Promise<AuthContext> {
  if (bearerToken(request.headers) !== null) return refuseApiToken(request, null);
  const session = await getSession(request.headers);
  const ip = clientIp(request);

  if (!session?.user) {
    throw new UnauthenticatedError();
  }

  if (session.user.banned === true) {
    await logAudit({
      actorId: session.user.id,
      action: 'auth.denied.disabled',
      resourceType: 'session',
      resourceId: session.session.id,
      after: { email: session.user.email },
      ip,
    });
    throw new AccountDisabledError();
  }

  // The absolute ceiling: beyond it, even active, the session closes — and it is
  // removed from the database, not only refused.
  const { maxSeconds } = sessionPolicy();
  const openedAt = new Date(session.session.createdAt).getTime();
  if (maxSeconds !== null && Date.now() - openedAt > maxSeconds * 1000) {
    await getDb().delete(sessions).where(eq(sessions.id, session.session.id));
    await logAudit({
      actorId: session.user.id,
      action: 'auth.session.expired',
      resourceType: 'session',
      resourceId: session.session.id,
      after: { reason: 'max_age', maxHours: maxSeconds / 3600 },
      ip,
    });
    throw new UnauthenticatedError();
  }

  const grants = await getUserGrants(session.user.id);
  const permissionSet = new Set<string>(grants.permissions);
  const userTwoFactor = (session.user as { twoFactorEnabled?: boolean | null }).twoFactorEnabled;
  const twoFactor = await twoFactorState(
    session.user.id,
    grants.permissions,
    userTwoFactor === true,
  );

  return {
    userId: session.user.id,
    email: session.user.email,
    name: session.user.name,
    image: session.user.image ?? null,
    roles: grants.roles,
    permissions: grants.permissions,
    ip,
    can: (permission) => !twoFactor.mustEnroll && permissionSet.has(permission),
    token: null,
    twoFactor,
  };
}

/**
 * A request that presents `Authorization: Bearer pup_…` authenticates through this
 * token, and through it alone: a cookie going with it is ignored.
 *
 * The token acts on behalf of its author, with the intersection of what it asks
 * for and what the author can do **today**: a removed role takes away from it what
 * it takes away, a disabled account disables it. It can never do more than its
 * author.
 */
async function authenticateToken(
  request: Request,
  bearer: string,
  permission: Permission,
): Promise<AuthContext> {
  const ip = clientIp(request);
  const refuse = async (
    reason: 'invalid' | 'revoked' | 'expired',
    actorId: string | null,
  ): Promise<never> => {
    await logAudit({
      actorId,
      action: 'permission.denied',
      resourceType: 'permission',
      resourceId: permission,
      after: {
        reason: `token_${reason}`,
        method: request.method,
        path: new URL(request.url).pathname,
      },
      ip,
    });
    throw new InvalidApiTokenError(reason);
  };

  const found = bearer === 'malformed' ? null : await findApiTokenByHash(hashApiToken(bearer));
  if (!found) return refuse('invalid', null);
  const { token, user } = found;
  if (token.revokedAt) return refuse('revoked', user.id);
  if (token.expiresAt && token.expiresAt.getTime() <= Date.now()) return refuse('expired', user.id);

  if (user.banned) {
    await logAudit({
      actorId: user.id,
      action: 'auth.denied.disabled',
      resourceType: 'api_token',
      resourceId: token.id,
      after: { email: user.email },
      ip,
    });
    throw new AccountDisabledError();
  }

  const grants = await getUserGrants(user.id);
  const held = new Set<string>(grants.permissions);
  const permissions = token.permissions.filter(
    (key): key is Permission => isPermission(key) && held.has(key),
  );
  const permissionSet = new Set<string>(permissions);
  const twoFactor = await twoFactorState(user.id, grants.permissions, user.twoFactorEnabled);
  await touchApiToken(token.id, ip);

  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    image: user.image,
    roles: grants.roles,
    permissions,
    ip,
    can: (key) => !twoFactor.mustEnroll && permissionSet.has(key),
    token: {
      id: token.id,
      name: token.name,
      applications: token.applicationIds ? new Set(token.applicationIds) : null,
    },
    twoFactor,
  };
}

/**
 * A team member: a session whose role carries at least one permission.
 *
 * The chat and the presence require no permission — they belong to the whole team
 * —, but an account without access, typically a sign-up waiting for a role to be
 * chosen for it, is not part of it yet: it reads nothing there, and nobody sees it
 * online. Neither is an account that still has to enable its second factor, the
 * time to do it.
 */
export function isTeamMember(auth: Pick<AuthContext, 'permissions' | 'twoFactor'>): boolean {
  return auth.permissions.length > 0 && !auth.twoFactor.mustEnroll;
}

/**
 * A team member's session: 401 without a session, 403 without any permission — or
 * as long as the required second factor is not enabled.
 */
export async function requireTeamMember(request: Request): Promise<AuthContext> {
  const auth = await requireSession(request);
  if (auth.twoFactor.mustEnroll) {
    await logAudit({
      actorId: auth.userId,
      action: 'permission.denied',
      resourceType: 'permission',
      resourceId: null,
      after: {
        reason: 'two_factor_required',
        method: request.method,
        path: new URL(request.url).pathname,
      },
      ip: auth.ip,
    });
    throw new TwoFactorRequiredError();
  }
  if (!isTeamMember(auth)) {
    await logAudit({
      actorId: auth.userId,
      action: 'permission.denied',
      resourceType: 'permission',
      resourceId: null,
      after: {
        reason: 'no_access',
        email: auth.email,
        roles: auth.roles,
        method: request.method,
        path: new URL(request.url).pathname,
      },
      ip: auth.ip,
    });
    throw new NoAccessError();
  }
  return auth;
}

export type PermissionOptions = {
  /**
   * The route checks itself, through `requireApplicationScope()`, that the targeted
   * application is covered by the token. Without this declaration, a token limited
   * to applications is refused: a route that does not think about it must not let
   * it act on everything.
   */
  applicationScoped?: boolean;
  /** The route is only done from the panel: no API token. */
  sessionOnly?: boolean;
};

/**
 * Requires a permission.
 *   → returns the authentication context if allowed
 *   → `UnauthenticatedError` (401) if no session, `InvalidApiTokenError` (401)
 *     for a malformed, unknown, revoked or expired API token
 *   → `ForbiddenError` (403) if the permission is missing, `ApiTokenScopeError`
 *     (403) if the token is not valid on this route
 *
 * A browser session or an API token (`Authorization: Bearer`). Every refusal is
 * logged in `audit_logs` with the actor and their IP.
 */
export async function requirePermission(
  request: Request,
  permission: Permission,
  options: PermissionOptions = {},
): Promise<AuthContext> {
  const bearer = bearerToken(request.headers);
  if (bearer !== null && options.sessionOnly) return refuseApiToken(request, permission);

  let auth: AuthContext;
  try {
    auth =
      bearer !== null
        ? await authenticateToken(request, bearer, permission)
        : await requireSession(request);
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      await logAudit({
        action: 'permission.denied',
        resourceType: 'permission',
        resourceId: permission,
        after: {
          reason: 'unauthenticated',
          method: request.method,
          path: new URL(request.url).pathname,
        },
        ip: clientIp(request),
      });
    }
    throw error;
  }

  // Required and absent: nothing other than "My account", the time to enable it. A
  // token of this account is worth no more than it.
  if (auth.twoFactor.mustEnroll) {
    await logAudit({
      actorId: auth.userId,
      action: 'permission.denied',
      resourceType: 'permission',
      resourceId: permission,
      after: {
        reason: 'two_factor_required',
        method: request.method,
        path: new URL(request.url).pathname,
      },
      ip: auth.ip,
    });
    throw new TwoFactorRequiredError();
  }

  if (!auth.can(permission)) {
    await logAudit({
      actorId: auth.userId,
      action: 'permission.denied',
      resourceType: 'permission',
      resourceId: permission,
      after: {
        reason: 'missing_permission',
        email: auth.email,
        roles: auth.roles,
        method: request.method,
        path: new URL(request.url).pathname,
      },
      ip: auth.ip,
    });
    throw new ForbiddenError(permission);
  }

  if (auth.token?.applications && !options.applicationScoped) {
    await logAudit({
      actorId: auth.userId,
      action: 'permission.denied',
      resourceType: 'permission',
      resourceId: permission,
      after: {
        reason: 'token_scope',
        method: request.method,
        path: new URL(request.url).pathname,
      },
      ip: auth.ip,
    });
    throw new ApiTokenScopeError('scope');
  }

  return auth;
}

/**
 * For a route declared `applicationScoped`: the targeted application must be
 * covered by the token. A session, or a token without limits, always passes.
 */
export async function requireApplicationScope(
  request: Request,
  auth: AuthContext,
  applicationId: string,
): Promise<void> {
  const covered = auth.token?.applications;
  if (!covered || covered.has(applicationId)) return;
  await logAudit({
    actorId: auth.userId,
    action: 'permission.denied',
    resourceType: 'application',
    resourceId: applicationId,
    after: {
      reason: 'token_application',
      method: request.method,
      path: new URL(request.url).pathname,
    },
    ip: auth.ip,
  });
  throw new ApiTokenScopeError('application');
}
