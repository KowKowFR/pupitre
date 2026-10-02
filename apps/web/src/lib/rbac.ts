import 'server-only';
import type { Permission, RoleKey } from '@pupitre/core';
import { getUserGrants, logAudit } from '@pupitre/db';
import { getSession } from './auth';
import {
  AccountDisabledError,
  ForbiddenError,
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
};

/** Session authentifiée, sans contrôle de permission. 401 sinon. */
export async function requireSession(request: Request): Promise<AuthContext> {
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

/**
 * Exige une permission.
 *   → retourne le contexte d'authentification si autorisé
 *   → `UnauthenticatedError` (401) si aucune session
 *   → `ForbiddenError` (403) si la session existe mais n'a pas la permission
 *
 * Tout refus est journalisé dans `audit_logs` avec l'acteur et son IP.
 */
export async function requirePermission(
  request: Request,
  permission: Permission,
): Promise<AuthContext> {
  let auth: AuthContext;
  try {
    auth = await requireSession(request);
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

  return auth;
}
