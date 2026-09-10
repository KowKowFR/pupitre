import 'server-only';
import { ROLE_DEFINITIONS, type RoleKey } from '@tp/core';
import {
  accounts,
  count,
  eq,
  getDb,
  logAudit,
  sessions,
  setUserRoles,
  twoFactors,
  users,
  verifications,
} from '@tp/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError } from 'better-auth/api';
import { admin, twoFactor } from 'better-auth/plugins';
import { createAccessControl } from 'better-auth/plugins/access';
import { adminAc, defaultStatements, userAc } from 'better-auth/plugins/admin/access';
import { getEnv } from './env';
import { PASSWORD_MIN_LENGTH } from './password-policy';
import { logger } from './logger';

/** Rôle attribué à un utilisateur créé sans rôle explicite. */
const DEFAULT_ROLE: RoleKey = 'viewer';

/**
 * Better Auth ne connaît par défaut que `user` et `admin`. On lui déclare notre
 * vocabulaire de rôles pour qu'il protège ses propres endpoints d'administration.
 *
 * Attention : ceci ne gouverne QUE les endpoints Better Auth. L'autorité sur les
 * permissions de l'API du panel reste `user_roles` + `requirePermission()`.
 */
const accessControl = createAccessControl(defaultStatements);

const authRoles = {
  admin: accessControl.newRole(adminAc.statements),
  operator: accessControl.newRole(userAc.statements),
  viewer: accessControl.newRole({}),
} satisfies Record<RoleKey, unknown>;

async function countUsers(): Promise<number> {
  const [row] = await getDb().select({ value: count() }).from(users);
  return row?.value ?? 0;
}

/**
 * L'inscription publique reste ouverte tant qu'aucun compte n'existe, pour
 * créer le premier administrateur. Ensuite elle dépend de `ALLOW_SIGNUP`.
 */
export async function isSignupOpen(): Promise<boolean> {
  if (getEnv().ALLOW_SIGNUP) return true;
  return (await countUsers()) === 0;
}

function buildAuth() {
  const env = getEnv();

  return betterAuth({
    appName: 'Bootstrap TP v2',
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    basePath: '/api/auth',
    trustedOrigins: [env.BETTER_AUTH_URL],

    database: drizzleAdapter(getDb(), {
      provider: 'pg',
      // Nos tables sont au pluriel : on les mappe explicitement aux modèles
      // Better Auth plutôt que de renommer le schéma du jalon 1.
      schema: {
        user: users,
        session: sessions,
        account: accounts,
        verification: verifications,
        twoFactor: twoFactors,
      },
    }),

    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      requireEmailVerification: false,
    },

    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },

    databaseHooks: {
      user: {
        create: {
          async before(user) {
            // Le tout premier compte devient administrateur.
            const isFirstUser = (await countUsers()) === 0;
            return {
              data: {
                ...user,
                role: isFirstUser ? ('admin' satisfies RoleKey) : (user.role ?? DEFAULT_ROLE),
              },
            };
          },
          async after(user) {
            const requested = typeof user.role === 'string' ? user.role : DEFAULT_ROLE;
            const roleKey: RoleKey =
              requested in ROLE_DEFINITIONS ? (requested as RoleKey) : DEFAULT_ROLE;

            try {
              await setUserRoles(user.id, [roleKey]);
            } catch (error) {
              logger.error({ userId: user.id, roleKey, error }, "attribution du rôle impossible");
            }

            // Fait brut de la création de la ligne. L'acteur est inconnu à ce
            // niveau : la route qui a déclenché la création trace qui a agi
            // (`auth.signup.succeeded` ou `user.created.by_admin`).
            await logAudit({
              actorId: null,
              action: 'user.created',
              resourceType: 'user',
              resourceId: user.id,
              after: { email: user.email, name: user.name, role: roleKey },
            });
          },
        },
      },
    },

    plugins: [
      admin({
        ac: accessControl,
        roles: authRoles,
        defaultRole: DEFAULT_ROLE,
        adminRoles: ['admin'],
      }),
      // Second facteur TOTP. `skipVerificationOnEnable` reste à sa valeur par
      // défaut (false) : le secret n'est armé qu'après un premier code valide,
      // sinon une application mal réglée enfermerait son propriétaire dehors.
      twoFactor({
        issuer: 'Bootstrap TP v2',
      }),
    ],
  });
}

type Auth = ReturnType<typeof buildAuth>;

let cached: Auth | null = null;

/** Instance Better Auth, construite à la première requête. */
export function getAuth(): Auth {
  cached ??= buildAuth();
  return cached;
}

/** Session courante, ou `null`. Ne throw pas. */
export async function getSession(headers: Headers) {
  try {
    return await getAuth().api.getSession({ headers });
  } catch (error) {
    logger.warn({ error }, 'lecture de session impossible');
    return null;
  }
}

export { APIError };

/** Refus d'inscription quand `ALLOW_SIGNUP` est à false et qu'un compte existe déjà. */
export function signupClosedError(): APIError {
  return new APIError('FORBIDDEN', {
    code: 'SIGNUP_DISABLED',
    message: "L'inscription publique est désactivée. Demandez un compte à un administrateur.",
  });
}

/** Suppression d'un utilisateur — passe par l'adaptateur pour rester cohérent. */
export async function deleteUserRow(userId: string): Promise<void> {
  await getDb().delete(users).where(eq(users.id, userId));
}
