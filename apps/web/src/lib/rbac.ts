import 'server-only';
import { isPermission, type Permission, type RoleKey } from '@pupitre/core';
import { findApiTokenByHash, getUserGrants, logAudit, touchApiToken } from '@pupitre/db';
import { bearerToken, hashApiToken } from './api-token-format';
import { getSession } from './auth';
import {
  AccountDisabledError,
  ApiTokenScopeError,
  ForbiddenError,
  InvalidApiTokenError,
  NoAccessError,
  UnauthenticatedError,
} from './errors';
import { clientIp } from './http';

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
};

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

  const grants = await getUserGrants(session.user.id);
  const permissionSet = new Set<string>(grants.permissions);

  return {
    userId: session.user.id,
    email: session.user.email,
    name: session.user.name,
    image: session.user.image ?? null,
    roles: grants.roles,
    permissions: grants.permissions,
    ip,
    can: (permission) => permissionSet.has(permission),
    token: null,
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
  await touchApiToken(token.id, ip);

  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    image: user.image,
    roles: grants.roles,
    permissions,
    ip,
    can: (key) => permissionSet.has(key),
    token: {
      id: token.id,
      name: token.name,
      applications: token.applicationIds ? new Set(token.applicationIds) : null,
    },
  };
}

/**
 * Membre de l'équipe : une session dont le rôle porte au moins une permission.
 *
 * La discussion et la présence ne demandent aucune permission — elles sont à
 * toute l'équipe —, mais un compte sans accès, typiquement une inscription qui
 * attend qu'on lui choisisse un rôle, n'en fait pas encore partie : il n'y lit
 * rien, et personne ne le voit en ligne.
 */
export function isTeamMember(auth: Pick<AuthContext, 'permissions'>): boolean {
  return auth.permissions.length > 0;
}

/** Session d'un membre de l'équipe : 401 sans session, 403 sans aucune permission. */
export async function requireTeamMember(request: Request): Promise<AuthContext> {
  const auth = await requireSession(request);
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
