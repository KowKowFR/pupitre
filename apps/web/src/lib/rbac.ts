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
 * Contrôle d'accès. Point d'entrée unique : `requirePermission()`.
 * Aucune route ne compare de rôle ni de permission à la main.
 */

export type AuthContext = {
  userId: string;
  email: string;
  name: string;
  /** L'URL versionnée de sa photo de profil, ou `null`. */
  image: string | null;
  roles: RoleKey[];
  permissions: Permission[];
  ip: string | null;
  /** Test local, sans nouvelle requête en base. */
  can: (permission: Permission) => boolean;
  /**
   * Le jeton d'API qui authentifie la requête, `null` pour une session de
   * navigateur. `applications` : celles qu'il couvre, `null` pour toutes.
   */
  token: { id: string; name: string; applications: ReadonlySet<string> | null } | null;
  /**
   * Le second facteur du compte, au regard de la politique de l'instance.
   * `mustEnroll` : exigé et absent — le compte n'a accès qu'à « Mon compte »,
   * le temps de l'activer : `can()` répond non à tout, `permissions` dit ce que
   * ses rôles lui donneront.
   */
  twoFactor: { enabled: boolean; required: boolean; mustEnroll: boolean };
};

/**
 * Le second facteur exigé et absent. Un compte sans mot de passe — qui n'entre
 * que par la connexion unique — n'y est pas tenu : il ne pourrait pas
 * l'activer (Better Auth le demande avec le mot de passe), et sa protection
 * est l'affaire du fournisseur d'identité.
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
 * Une route qui ne se fait que depuis le panel a reçu un jeton d'API : 403, dit
 * comme tel — un 401 ferait croire à la CI que son jeton ne vaut rien.
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
 * Session de navigateur authentifiée, sans contrôle de permission. 401 sinon.
 * Un jeton d'API n'en tient pas lieu : ce qui ne demande qu'une session — son
 * compte, son mot de passe, la discussion, ses jetons — se fait depuis le panel.
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

  // Le plafond absolu : au-delà, même active, la session se ferme — et elle
  // est retirée de la base, pas seulement refusée.
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
 * Une requête qui présente `Authorization: Bearer pup_…` s'authentifie par ce
 * jeton, et par lui seul : un cookie qui l'accompagnerait est ignoré.
 *
 * Le jeton agit au nom de son auteur, avec l'intersection de ce qu'il demande
 * et de ce que l'auteur peut **aujourd'hui** : un rôle retiré lui retire ce
 * qu'il retire, un compte désactivé le désactive. Il ne peut jamais en faire
 * plus que son auteur.
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
 * Membre de l'équipe : une session dont le rôle porte au moins une permission.
 *
 * La discussion et la présence ne demandent aucune permission — elles sont à
 * toute l'équipe —, mais un compte sans accès, typiquement une inscription qui
 * attend qu'on lui choisisse un rôle, n'en fait pas encore partie : il n'y lit
 * rien, et personne ne le voit en ligne. Un compte qui doit encore activer son
 * second facteur non plus, le temps de le faire.
 */
export function isTeamMember(auth: Pick<AuthContext, 'permissions' | 'twoFactor'>): boolean {
  return auth.permissions.length > 0 && !auth.twoFactor.mustEnroll;
}

/**
 * Session d'un membre de l'équipe : 401 sans session, 403 sans aucune
 * permission — ou tant que le second facteur exigé n'est pas activé.
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
   * La route vérifie elle-même, par `requireApplicationScope()`, que
   * l'application visée est couverte par le jeton. Sans cette déclaration, un
   * jeton limité à des applications est refusé : une route qui n'y pense pas
   * ne doit pas le laisser agir sur tout.
   */
  applicationScoped?: boolean;
  /** La route ne se fait que depuis le panel : aucun jeton d'API. */
  sessionOnly?: boolean;
};

/**
 * Exige une permission.
 *   → retourne le contexte d'authentification si autorisé
 *   → `UnauthenticatedError` (401) si aucune session, `InvalidApiTokenError`
 *     (401) pour un jeton d'API mal formé, inconnu, révoqué ou échu
 *   → `ForbiddenError` (403) si la permission manque, `ApiTokenScopeError`
 *     (403) si le jeton n'a pas cours sur cette route
 *
 * Une session de navigateur ou un jeton d'API (`Authorization: Bearer`).
 * Tout refus est journalisé dans `audit_logs` avec l'acteur et son IP.
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

  // Exigé et absent : rien d'autre que « Mon compte », le temps de l'activer.
  // Un jeton de ce compte ne vaut pas mieux que lui.
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
 * Pour une route déclarée `applicationScoped` : l'application visée doit être
 * couverte par le jeton. Une session, ou un jeton sans limite, passe toujours.
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
