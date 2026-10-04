import 'server-only';
import {
  LOCKED_ROLE,
  SIGNUP_ROLE,
  SSO_PROVIDER_ID,
  claimValues,
  roleFromGroups,
  ssoDiscoveryUrl,
  ssoScopes,
  type RoleKey,
} from '@pupitre/core';
import {
  accounts,
  and,
  count,
  eq,
  getDb,
  getRoleByKey,
  getUserGrants,
  isNotNull,
  logAudit,
  sessions,
  setUserRoles,
  sql,
  twoFactors,
  users,
  verifications,
} from '@pupitre/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { createAuthMiddleware } from 'better-auth/api';
import { admin, twoFactor } from 'better-auth/plugins';
import { genericOAuth } from 'better-auth/plugins/generic-oauth';
import { createAccessControl } from 'better-auth/plugins/access';
import { adminAc, defaultStatements, userAc } from 'better-auth/plugins/admin/access';
import { INVITATION_TTL_MS, sendAccountMail } from './account-mail';
import { countActiveAdmins } from './admins';
import { createAuthRateLimitStorage } from './auth-rate-limit';
import { getEnv } from './env';
import { clientIp } from './http';
import { PASSWORD_MIN_LENGTH } from './password-policy';
import { logger } from './logger';
import { getRedis } from './redis';
import { sessionPolicy, type SessionPolicy } from './session-policy';
import { peekSsoGroups, rememberSsoGroups, ssoState, takeSsoGroups, type SsoRuntime } from './sso';

/**
 * The role given to a user created without an explicit role — that is, through
 * public sign-up: no permission, waiting for an administrator. An account created
 * from `/admin/users` carries the role chosen by that administrator.
 */
const DEFAULT_ROLE: RoleKey = SIGNUP_ROLE;

/**
 * A reset link's lifetime: one hour.
 *
 * It is Better Auth's default value, taken explicitly so that it is readable here
 * rather than guessable in `node_modules`. One hour, because the person asking
 * for a reset is in front of their screen when they ask: they do not need three
 * days, and a link that opens an account has no business in an inbox longer than
 * necessary.
 *
 * The invitation, for its part, lasts 72 hours — see `INVITATION_TTL_MS`. Both
 * links use the same machinery, but not the same situation: one answers an
 * immediate request, the other arrives unannounced.
 */
const PASSWORD_RESET_TTL_SECONDS = 3600;

/**
 * Where the person who clicks lands.
 *
 * Two pages for a single mechanism: "choosing one's first password" and
 * "choosing a new one" are the same technical operation and two different
 * situations, and a screen saying "reset your password" to someone who never had
 * one would simply be wrong.
 *
 * The choice is made **here, on the server side**, from the account's state — and
 * not from the `redirectTo` the caller sends to Better Auth. The difference
 * matters: `/api/auth/request-password-reset` is public, and if the email's
 * wording followed a request parameter, anyone could have a message saying "an
 * administrator opened an access for you" sent to any address.
 */
export const INVITATION_PATH = '/invitation';
const RESET_PASSWORD_PATH = '/reset-password';

/**
 * Does this account already have a password?
 *
 * It is the only discriminant between an invitation and a reset, and it is
 * **unforgeable**: it depends on no input from the caller. An account created by
 * invitation has no `accounts` row of type `credential` until the person chose
 * their password — Better Auth creates it at `reset-password` time. The day the
 * row exists, the invitation is consumed and the account is an ordinary account.
 */
export async function hasPassword(userId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ value: count() })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, userId),
        eq(accounts.providerId, 'credential'),
        isNotNull(accounts.password),
      ),
    );
  return (row?.value ?? 0) > 0;
}

/**
 * Rewrites the landing page of the link made by Better Auth.
 *
 * The received link targets `/api/auth/reset-password/{token}?callbackURL=…`: a
 * GET that **checks the token without consuming it**, then redirects to
 * `callbackURL` with `?token=` if it is good, or `?error=INVALID_TOKEN` if it is
 * expired. We keep this detour — it is what makes an expired link show a message
 * instead of letting someone type a password for nothing —, we only change the
 * destination.
 *
 * Rewriting rather than rebuilding: the URL's shape belongs to Better Auth, and
 * copying it here hard-coded would be a duplicate that would break silently at
 * the first update.
 */
function withLanding(rawUrl: string, path: string): string {
  const url = new URL(rawUrl);
  url.searchParams.set('callbackURL', path);
  return url.toString();
}

/**
 * Better Auth only knows `user` and `admin` by default. We declare our role
 * vocabulary to it so that it protects its own administration endpoints.
 *
 * Careful: this ONLY governs the Better Auth endpoints. The authority over the
 * panel API's permissions stays `user_roles` + `requirePermission()`.
 */
const accessControl = createAccessControl(defaultStatements);

const authRoles = {
  admin: accessControl.newRole(adminAc.statements),
  operator: accessControl.newRole(userAc.statements),
  auditor: accessControl.newRole({}),
  viewer: accessControl.newRole({}),
  'no-access': accessControl.newRole({}),
} satisfies Record<RoleKey, unknown>;

async function countUsers(): Promise<number> {
  const [row] = await getDb().select({ value: count() }).from(users);
  return row?.value ?? 0;
}

/**
 * Public sign-up stays open as long as no account exists, to create the first
 * administrator. Afterwards it depends on `ALLOW_SIGNUP`.
 */
export async function isSignupOpen(): Promise<boolean> {
  if (getEnv().ALLOW_SIGNUP) return true;
  return (await countUsers()) === 0;
}

/**
 * After a sign-in through the identity provider: trace it, and — if the provider
 * is authoritative — bring the role back in line with its groups.
 *
 * The last administrator is never demoted that way: a badly named group at the
 * provider must not lock the instance out. The role is then kept, and the log
 * says why.
 */
async function afterSsoSignIn(
  sso: SsoRuntime,
  user: { id: string; email: string },
  ip: string | null,
): Promise<void> {
  const groups = takeSsoGroups(user.email);
  const before = await getUserGrants(user.id);
  let roles = before.roles;

  if (sso.settings.syncRoles && groups !== null) {
    const wanted = roleFromGroups(groups, sso.settings).role;
    const current = before.roles.length === 1 ? before.roles[0] : null;
    if (wanted !== current) {
      const known = await getRoleByKey(wanted);
      const losesAdmin = before.roles.includes(LOCKED_ROLE) && wanted !== LOCKED_ROLE;
      if (!known) {
        logger.warn({ role: wanted }, 'single sign-on: unknown role, current role kept');
      } else if (losesAdmin && (await countActiveAdmins(user.id)) === 0) {
        await logAudit({
          actorId: null,
          action: 'auth.sso.role.kept',
          resourceType: 'user',
          resourceId: user.id,
          after: { email: user.email, roles: before.roles, wanted, reason: 'last_admin' },
          ip,
        });
      } else {
        await setUserRoles(user.id, [wanted]);
        roles = [wanted];
        await logAudit({
          actorId: null,
          action: 'user.role.changed',
          resourceType: 'user',
          resourceId: user.id,
          before: { roles: before.roles },
          after: { roles: [wanted], email: user.email, source: 'sso', groups },
          ip,
        });
      }
    }
  }

  await logAudit({
    actorId: user.id,
    action: 'auth.sso.login.succeeded',
    resourceType: 'session',
    resourceId: user.id,
    after: { email: user.email, provider: sso.settings.label, groups, roles },
    ip,
  });
}

/**
 * The rate limiting's counter, shared by all the Better Auth instances this
 * process makes — and, through Redis, by all the panels. See
 * `auth-rate-limit.ts`.
 */
const rateLimitStorage = createAuthRateLimitStorage(getRedis, logger);

function buildAuth(sso: SsoRuntime | null, sessionLimits: SessionPolicy) {
  const env = getEnv();

  return betterAuth({
    appName: 'Pupitre',
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    basePath: '/api/auth',
    trustedOrigins: [env.BETTER_AUTH_URL],

    database: drizzleAdapter(getDb(), {
      provider: 'pg',
      // Our tables are plural: we map them explicitly to the Better Auth models rather
      // than renaming the original schema.
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

      /**
       * No separate address verification, and it is an argued choice.
       *
       * On this instance, there are only two ways to obtain a password: clicking an
       * invitation link, or clicking a reset link. Both arrive **by email at the
       * account's address**. Receiving the link *is* the proof that one controls the
       * mailbox — a second "confirm your address" email would prove nothing more, it
       * would add a click and one more account state to manage.
       *
       * Two more arguments, measured and not assumed:
       *   — on a new instance, no SMTP channel is configured; requiring a verification
       *     would lock out the first administrator, who is precisely the one who must
       *     go and configure SMTP;
       *   — in 1.7.3, the email verification token is a signed JWT, not a
       *     `verifications` row: it is **replayable until it expires**, whereas the
       *     reset token is consumed once and for all. The mechanism relied upon is
       *     therefore the more solid of the two.
       *
       * `users.email_verified` is not abandoned for all that: it is set to `true` in
       * `onPasswordReset`, at the exact moment the proof is made.
       */
      requireEmailVerification: false,

      resetPasswordTokenExpiresIn: PASSWORD_RESET_TTL_SECONDS,

      /**
       * All the account's sessions go down.
       *
       * The same rule as the voluntary password change, and the same reason even more
       * so: one resets precisely because one lost control of one's account. Letting
       * the open sessions live — the thief's included — would empty the operation of
       * its point.
       *
       * Unlike `changePassword`, Better Auth **also** closes the caller's session here.
       * It is consistent: there is none. The person arrives signed out on the link,
       * and the screen sends them to sign in with their new password.
       */
      revokeSessionsOnPasswordReset: true,

      /**
       * Sending the link. Better Auth makes the token, the `verifications` row and the
       * URL; we only choose the landing page, the text, and the path through which the
       * message goes out.
       *
       * None of that is reimplemented: neither the token's generation, nor its
       * duration, nor its single use, nor the public route's anti-enumeration.
       */
      async sendResetPassword({ user, url }) {
        const invitation = !(await hasPassword(user.id));
        const kind = invitation ? 'invitation' : 'password_reset';

        // A disabled account cannot sign in: sending it what it takes to choose a
        // password would be useless and would suggest that access is restored. The
        // public route's response, for its part, does not change by a byte — that is
        // what matters.
        const [row] = await getDb()
          .select({ banned: users.banned })
          .from(users)
          .where(eq(users.id, user.id));

        if (row?.banned === true) {
          await logAudit({
            actorId: null,
            action: 'auth.password_reset.refused',
            resourceType: 'user',
            resourceId: user.id,
            after: { reason: 'account_disabled' },
          });
          return;
        }

        // No token, no URL in the log: the trace says that a link went out, to whom, and
        // until when it is valid. It opens nothing.
        await logAudit({
          actorId: null,
          action: 'auth.password_reset.requested',
          resourceType: 'user',
          resourceId: user.id,
          after: { kind, email: user.email },
        });

        // An invitation lasts longer than a reset. The token stays Better Auth's; only
        // its row's expiry is pushed back, and the email announces the expiry **really**
        // set — never the one we would have liked to set. See `extendResetToken()`.
        const expiresAt = invitation
          ? ((await extendResetToken(user.id, INVITATION_TTL_MS)) ??
            new Date(Date.now() + PASSWORD_RESET_TTL_SECONDS * 1000))
          : new Date(Date.now() + PASSWORD_RESET_TTL_SECONDS * 1000);

        sendAccountMail({
          kind,
          userId: user.id,
          to: user.email,
          recipientName: user.name,
          url: withLanding(url, invitation ? INVITATION_PATH : RESET_PASSWORD_PATH),
          expiresAt,
          actor: null,
        });
      },

      /**
       * After the new password is written.
       *
       * It is here that `email_verified` switches to `true`: the person just proved, by
       * clicking, that they read the mailbox. Setting it earlier would lie; never
       * setting it would leave the column forever false and useless.
       */
      async onPasswordReset({ user }) {
        await getDb()
          .update(users)
          .set({ emailVerified: true, updatedAt: new Date() })
          .where(eq(users.id, user.id));

        await logAudit({
          actorId: user.id,
          action: 'auth.password_reset.completed',
          resourceType: 'user',
          resourceId: user.id,
          after: { email: user.email, emailVerified: true, revokedAllSessions: true },
        });
      },
    },

    /**
     * Rate limiting — Better Auth's, not ours.
     *
     * It has always been there, but `enabled` defaults to
     * `NODE_ENV === 'production'`: it was therefore **silent in development**, that
     * is precisely where it is checked. We force it, so that the behavior observed
     * locally is production's.
     *
     * The rules taken as is from the library's default (3 requests / 60 s on
     * `/request-password-reset`, 3 / 10 s on `/sign-in`) are written here rather
     * than left implicit: a reset form without a guard is a way to send emails from
     * someone else's server, and this sentence deserves to be explicitly true.
     *
     * The key is (IP, path), and the counter lives in Redis (`customStorage`):
     * several panels behind a load balancer count together, instead of multiplying
     * the limit by their number. The sessions, for their part, stay in the database
     * — a `secondaryStorage` would have moved them. With a silent Redis, the count is
     * done in memory, as before.
     */
    rateLimit: {
      enabled: true,
      customStorage: rateLimitStorage,
      customRules: {
        // The public form: three requests per minute and per IP.
        '/request-password-reset': { window: 60, max: 3 },
        // Consuming the token. The token is 24 random characters and cannot be guessed;
        // the bound is there for the cost, not for the secret.
        '/reset-password': { window: 60, max: 10 },
      },
    },

    /**
     * The duration without activity is set in the settings ("Accounts and
     * sessions"). Better Auth extends a used session when its last extension is
     * older than `updateAge`: it must therefore stay well below the duration itself
     * — otherwise a one-hour session would expire after one hour, active or not. The
     * absolute ceiling, for its part, is held by `requireSession()`.
     */
    session: {
      expiresIn: sessionLimits.idleSeconds,
      updateAge: Math.min(60 * 60 * 24, Math.floor(sessionLimits.idleSeconds / 4)),
    },

    /**
     * Linking a single sign-on to an existing account with the same email: only if
     * the setting wants it, and only when **the provider** declares the email
     * verified — the provider is not marked "trusted", which would force Better Auth
     * to take it at its word. On Pupitre's side, verification is not required: an
     * account created by an administrator never clicked a link, and yet it is the
     * right one.
     */
    account: {
      accountLinking: {
        enabled: sso?.settings.linkByEmail ?? false,
        requireLocalEmailVerified: false,
      },
    },

    hooks: sso
      ? {
          after: createAuthMiddleware(async (ctx) => {
            // The generic provider goes through Better Auth's "social" routes: its return is
            // `/callback/oidc`.
            if (!ctx.path.startsWith('/callback')) return;
            const user = ctx.context.newSession?.user;
            if (!user) return;
            try {
              await afterSsoSignIn(
                sso,
                { id: user.id, email: user.email },
                ctx.request ? clientIp(ctx.request) : null,
              );
            } catch (error) {
              logger.error({ err: error, userId: user.id }, 'single sign-on: follow-up failed');
            }
          }),
        }
      : undefined,

    databaseHooks: {
      user: {
        create: {
          async before(user) {
            // The very first account becomes administrator.
            const isFirstUser = (await countUsers()) === 0;
            // An account born from a single sign-on receives its groups' role right away —
            // not "No access" followed by a change, which would send two notifications for a
            // single arrival.
            const groups = sso ? peekSsoGroups(user.email) : null;
            const ssoRole = sso && groups ? roleFromGroups(groups, sso.settings).role : null;
            return {
              data: {
                ...user,
                role: isFirstUser
                  ? ('admin' satisfies RoleKey)
                  : (ssoRole ?? user.role ?? DEFAULT_ROLE),
              },
            };
          },
          async after(user) {
            // The requested role must exist in the database: the starting ones, or a role
            // created from the roles screen — it is what a single sign-on mapping can
            // designate.
            const requested = typeof user.role === 'string' ? user.role : DEFAULT_ROLE;
            const roleKey: RoleKey = (await getRoleByKey(requested)) ? requested : DEFAULT_ROLE;

            try {
              await setUserRoles(user.id, [roleKey]);
            } catch (error) {
              logger.error({ userId: user.id, roleKey, error }, 'role assignment failed');
            }

            // The raw fact of the row's creation. The actor is unknown at this level: the
            // route that triggered the creation traces who acted (`auth.signup.succeeded` or
            // `user.created.by_admin`).
            await logAudit({
              actorId: null,
              action: 'user.created',
              resourceType: 'user',
              resourceId: user.id,
              after: {
                email: user.email,
                name: user.name,
                role: roleKey,
                ...(sso && peekSsoGroups(user.email) !== null
                  ? { origin: 'sso', provider: sso.settings.label }
                  : {}),
              },
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
      // TOTP second factor. `skipVerificationOnEnable` stays at its default value
      // (false): the secret is only armed after a first valid code, otherwise a badly
      // set app would lock its owner out.
      twoFactor({
        issuer: 'Pupitre',
      }),
      ...(sso
        ? [
            genericOAuth({
              config: [
                {
                  providerId: SSO_PROVIDER_ID,
                  name: sso.settings.label,
                  discoveryUrl: ssoDiscoveryUrl(sso.settings.issuer),
                  // The groups, hence the roles, come from the identity token: it must be checked
                  // against the provider's keys.
                  requireIdTokenVerification: true,
                  clientId: sso.settings.clientId,
                  clientSecret: sso.clientSecret,
                  scopes: ssoScopes(sso.settings.scopes),
                  pkce: true,
                  disableSignUp: !sso.settings.autoCreate,
                  // Signing out of the panel does not sign out of the provider.
                  disableProviderLogout: true,
                  mapProfileToUser(profile) {
                    // The only moment the provider's profile is visible: its groups are kept
                    // for the account's creation and for after sign-in (`afterSsoSignIn`).
                    const groups = claimValues(profile, sso.settings.groupsClaim);
                    if (typeof profile.email === 'string') rememberSsoGroups(profile.email, groups);
                    return {};
                  },
                },
              ],
            }),
          ]
        : []),
    ],
  });
}

type Auth = ReturnType<typeof buildAuth>;

declare global {
  var __pupitreAuth: { key: string; auth: Auth } | undefined;
}

/**
 * Specific to this module load. An instance built by a previous version of the
 * code — `next dev`'s hot reload — must not be reused: its hooks would be the old
 * ones.
 */
const MODULE_LOAD = Math.random().toString(36).slice(2);

/**
 * The Better Auth instance, built at the first request — and rebuilt when single
 * sign-on changes (`lib/sso.ts`). The sessions live in the database and their
 * cookies are signed by `BETTER_AUTH_SECRET`: a rebuild signs nobody out.
 */
export function getAuth(): Auth {
  const sso = ssoState().runtime;
  const limits = sessionPolicy();
  const key = `${MODULE_LOAD}:${sso?.key ?? 'sans-sso'}:${limits.idleSeconds}`;
  const cached = globalThis.__pupitreAuth;
  if (cached?.key === key) return cached.auth;
  const auth = buildAuth(sso, limits);
  globalThis.__pupitreAuth = { key, auth };
  return auth;
}

/** The current session, or `null`. Does not throw. */
export async function getSession(headers: Headers) {
  try {
    return await getAuth().api.getSession({ headers });
  } catch (error) {
    logger.warn({ error }, 'session could not be read');
    return null;
  }
}

/* ---------------------------------------------------------------------------
   The reset tokens, seen from our side
   ------------------------------------------------------------------------- */

/**
 * ## The only place in the project that touches Better Auth's rows
 *
 * Better Auth stores a reset token in `verifications` in the shape
 * `identifier = 'reset-password:{token}'`, `value = {user id}`. It is the one that
 * writes it, the one that consumes it (once, in a transaction), the one that
 * checks its expiry. We reimplement none of that.
 *
 * The two functions below do strictly two things the library does not expose:
 *
 *   1. **pushing back the expiry** of a freshly created token, because an
 *      invitation and a reset do not have the same lifetime and
 *      `resetPasswordTokenExpiresIn` is a global setting;
 *   2. **revoking** an account's current tokens, which is exactly what an
 *      administrator means by "cancel this invitation".
 *
 * The `reset-password:` prefix is an internal detail of the library, and it is
 * assumed as such: if a future version changed it, `extendResetToken` would
 * return `null` and the invitation would fall back to one hour — the email would
 * then honestly announce one hour, because it reads the expiry returned here and
 * not the one we hoped for. A visible degradation, not a silent lie.
 */
const RESET_TOKEN_PREFIX = 'reset-password:';

function resetTokensOf(userId: string) {
  return and(
    eq(verifications.value, userId),
    sql`${verifications.identifier} like ${`${RESET_TOKEN_PREFIX}%`}`,
  );
}

/**
 * Pushes back the expiry of an account's current reset tokens. Returns the new
 * expiry, or `null` if no row was touched.
 */
async function extendResetToken(userId: string, ttlMs: number): Promise<Date | null> {
  const expiresAt = new Date(Date.now() + ttlMs);

  const rows = await getDb()
    .update(verifications)
    .set({ expiresAt, updatedAt: new Date() })
    .where(resetTokensOf(userId))
    .returning({ id: verifications.id });

  if (rows.length === 0) {
    logger.warn(
      { userId },
      'no reset token to extend — has the Better Auth format changed?',
    );
    return null;
  }
  return expiresAt;
}

/**
 * Revokes all of an account's current links. Returns the number of dead links.
 *
 * Called when an administrator cancels an invitation, and **before** resending
 * one: without that, two links would open the same account and the first would
 * survive the second one's cancellation.
 */
export async function revokeResetTokens(userId: string): Promise<number> {
  const rows = await getDb()
    .delete(verifications)
    .where(resetTokensOf(userId))
    .returning({ id: verifications.id });
  return rows.length;
}
