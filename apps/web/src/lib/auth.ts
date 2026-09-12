import 'server-only';
import { ROLE_DEFINITIONS, type RoleKey } from '@pupitre/core';
import {
  accounts,
  and,
  count,
  eq,
  getDb,
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
import { APIError } from 'better-auth/api';
import { admin, twoFactor } from 'better-auth/plugins';
import { createAccessControl } from 'better-auth/plugins/access';
import { adminAc, defaultStatements, userAc } from 'better-auth/plugins/admin/access';
import { INVITATION_TTL_MS, sendAccountMail } from './account-mail';
import { getEnv } from './env';
import { PASSWORD_MIN_LENGTH } from './password-policy';
import { logger } from './logger';

/** Rôle attribué à un utilisateur créé sans rôle explicite. */
const DEFAULT_ROLE: RoleKey = 'viewer';

/**
 * Durée de vie d'un lien de réinitialisation : une heure.
 *
 * C'est la valeur par défaut de Better Auth, reprise explicitement pour qu'elle
 * soit lisible ici plutôt que devinable dans `node_modules`. Une heure, parce
 * que la personne qui demande une réinitialisation est devant son écran au
 * moment où elle la demande : elle n'a pas besoin de trois jours, et un lien qui
 * ouvre un compte n'a rien à faire dans une boîte de réception plus longtemps
 * que nécessaire.
 *
 * L'invitation, elle, vaut 72 heures — voir `INVITATION_TTL_MS`. Les deux liens
 * empruntent la même machinerie, mais pas la même situation : l'un répond à une
 * demande immédiate, l'autre arrive sans prévenir.
 */
export const PASSWORD_RESET_TTL_SECONDS = 3600;

/**
 * Où atterrit la personne qui clique.
 *
 * Deux pages pour un seul mécanisme : « choisir son premier mot de passe » et
 * « en choisir un nouveau » sont la même opération technique et deux situations
 * différentes, et un écran qui dirait « réinitialiser votre mot de passe » à
 * quelqu'un qui n'en a jamais eu serait simplement faux.
 *
 * Le choix se fait **ici, côté serveur**, à partir de l'état du compte — et pas
 * à partir du `redirectTo` que l'appelant envoie à Better Auth. La différence
 * compte : `/api/auth/request-password-reset` est public, et si le libellé de
 * l'e-mail suivait un paramètre de requête, n'importe qui pourrait faire
 * envoyer à n'importe quelle adresse un message disant « un administrateur vous
 * a ouvert un accès ».
 */
export const INVITATION_PATH = '/invitation';
export const RESET_PASSWORD_PATH = '/reset-password';

/**
 * Ce compte a-t-il déjà un mot de passe ?
 *
 * C'est l'unique discriminant entre une invitation et une réinitialisation, et
 * il est **infalsifiable** : il ne dépend d'aucune entrée de l'appelant. Un
 * compte créé par invitation n'a aucune ligne `accounts` de type `credential`
 * tant que la personne n'a pas choisi son mot de passe — Better Auth la crée au
 * moment du `reset-password`. Le jour où la ligne existe, l'invitation est
 * consommée et le compte est un compte ordinaire.
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
 * Réécrit la page d'atterrissage du lien fabriqué par Better Auth.
 *
 * Le lien reçu vise `/api/auth/reset-password/{jeton}?callbackURL=…` : un GET
 * qui **vérifie le jeton sans le consommer**, puis redirige vers `callbackURL`
 * avec `?token=` s'il est bon, ou `?error=INVALID_TOKEN` s'il est périmé. On
 * garde ce détour — c'est lui qui fait qu'un lien expiré affiche un message au
 * lieu de laisser quelqu'un saisir un mot de passe pour rien —, on ne change
 * que la destination.
 *
 * Réécrire plutôt que reconstruire : la forme de l'URL appartient à Better
 * Auth, et la recopier ici en dur serait un doublon qui casserait en silence à
 * la première mise à jour.
 */
function withLanding(rawUrl: string, path: string): string {
  const url = new URL(rawUrl);
  url.searchParams.set('callbackURL', path);
  return url.toString();
}

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
    appName: 'Pupitre',
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

      /**
       * Aucune vérification d'adresse séparée, et c'est un choix argumenté.
       *
       * Sur cette instance, il n'existe que deux façons d'obtenir un mot de
       * passe : cliquer sur un lien d'invitation, ou cliquer sur un lien de
       * réinitialisation. Les deux arrivent **par e-mail à l'adresse du
       * compte**. Recevoir le lien *est* la preuve qu'on contrôle la boîte —
       * un second e-mail « confirmez votre adresse » ne prouverait rien de
       * plus, il ajouterait un clic et un état de compte supplémentaire à
       * gérer.
       *
       * Deux arguments de plus, mesurés et pas supposés :
       *   — sur une instance neuve, aucun canal SMTP n'est configuré ; exiger
       *     une vérification enfermerait dehors le premier administrateur, qui
       *     est justement celui qui doit aller configurer le SMTP ;
       *   — en 1.7.3, le jeton de vérification d'e-mail est un JWT signé, pas
       *     une ligne de `verifications` : il est **rejouable jusqu'à son
       *     expiration**, là où le jeton de réinitialisation est consommé une
       *     fois pour toutes. Le mécanisme sur lequel on s'appuie est donc le
       *     plus solide des deux.
       *
       * `users.email_verified` n'est pas abandonné pour autant : il est posé à
       * `true` dans `onPasswordReset`, au moment exact où la preuve est faite.
       */
      requireEmailVerification: false,

      resetPasswordTokenExpiresIn: PASSWORD_RESET_TTL_SECONDS,

      /**
       * Toutes les sessions du compte tombent.
       *
       * Même règle que le changement de mot de passe volontaire, et la même
       * raison en plus fort : on réinitialise précisément parce qu'on a perdu
       * la main sur son compte. Laisser vivre les sessions ouvertes — celle du
       * voleur comprise — viderait la manœuvre de son intérêt.
       *
       * Contrairement à `changePassword`, Better Auth ferme ici **aussi** la
       * session de l'appelant. C'est cohérent : il n'y en a pas. La personne
       * arrive déconnectée sur le lien, et l'écran la renvoie se connecter avec
       * son nouveau mot de passe.
       */
      revokeSessionsOnPasswordReset: true,

      /**
       * L'envoi du lien. Better Auth fabrique le jeton, la ligne de
       * `verifications` et l'URL ; nous ne faisons que choisir la page
       * d'atterrissage, le texte, et le chemin par lequel le message part.
       *
       * Rien de tout cela n'est réimplémenté : ni la génération du jeton, ni sa
       * durée, ni son usage unique, ni l'anti-énumération de la route publique.
       */
      async sendResetPassword({ user, url }) {
        const invitation = !(await hasPassword(user.id));
        const kind = invitation ? 'invitation' : 'password_reset';

        // Un compte désactivé ne peut pas se connecter : lui envoyer de quoi
        // choisir un mot de passe ne servirait à rien et donnerait à croire
        // que l'accès est rétabli. La réponse de la route publique, elle, ne
        // change pas d'un octet — c'est ce qui compte.
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

        // Aucun jeton, aucune URL dans le journal : la trace dit qu'un lien est
        // parti, à qui, et jusqu'à quand il vaut. Elle n'ouvre rien.
        await logAudit({
          actorId: null,
          action: 'auth.password_reset.requested',
          resourceType: 'user',
          resourceId: user.id,
          after: { kind, email: user.email },
        });

        // Une invitation vaut plus longtemps qu'une réinitialisation. Le jeton
        // reste celui de Better Auth ; seule l'échéance de sa ligne est
        // repoussée, et l'e-mail annonce l'échéance **réellement** posée —
        // jamais celle qu'on aurait voulu poser. Voir `extendResetToken()`.
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
       * Après l'écriture du nouveau mot de passe.
       *
       * C'est ici que `email_verified` passe à `true` : la personne vient de
       * prouver, en cliquant, qu'elle relève la boîte. Le poser plus tôt
       * mentirait ; ne jamais le poser laisserait la colonne éternellement
       * fausse et sans usage.
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
     * Limitation de débit — celle de Better Auth, pas la nôtre.
     *
     * Elle est là depuis toujours, mais `enabled` vaut par défaut
     * `NODE_ENV === 'production'` : elle était donc **muette en développement**,
     * c'est-à-dire précisément là où on la vérifie. On la force, pour que le
     * comportement observé en local soit celui de la production.
     *
     * Les règles reprises telles quelles du défaut de la bibliothèque
     * (3 requêtes / 60 s sur `/request-password-reset`, 3 / 10 s sur
     * `/sign-in`) sont écrites ici plutôt que laissées implicites : un
     * formulaire de réinitialisation sans garde est un moyen d'envoyer des
     * e-mails depuis le serveur de quelqu'un d'autre, et cette phrase mérite
     * d'être vraie explicitement.
     *
     * La clé est (IP, chemin). Le stockage est en mémoire : c'est suffisant
     * ici — le panel est un seul processus — mais ce serait faux avec plusieurs
     * répliques, chacune comptant pour elle. Le corriger demanderait une table
     * `rateLimit` (donc une migration) ou un `secondaryStorage` Redis, qui
     * déplacerait aussi les sessions. Ni l'un ni l'autre n'est justifié
     * aujourd'hui : c'est une dette assumée, écrite ici pour être trouvée.
     */
    rateLimit: {
      enabled: true,
      customRules: {
        // Le formulaire public : trois demandes par minute et par IP.
        '/request-password-reset': { window: 60, max: 3 },
        // La consommation du jeton. Le jeton fait 24 caractères aléatoires et
        // n'est pas devinable ; la borne est là pour le coût, pas pour le
        // secret.
        '/reset-password': { window: 60, max: 10 },
      },
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
        issuer: 'Pupitre',
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

/* ---------------------------------------------------------------------------
   Les jetons de réinitialisation, vus depuis notre côté
   ------------------------------------------------------------------------- */

/**
 * ## Le seul endroit du projet qui touche aux lignes de Better Auth
 *
 * Better Auth range un jeton de réinitialisation dans `verifications` sous la
 * forme `identifier = 'reset-password:{jeton}'`, `value = {id de l'utilisateur}`.
 * C'est lui qui l'écrit, lui qui le consomme (une seule fois, dans une
 * transaction), lui qui vérifie son échéance. On ne réimplémente rien de tout
 * cela.
 *
 * Les deux fonctions ci-dessous font strictement deux choses que la
 * bibliothèque n'expose pas :
 *
 *   1. **repousser l'échéance** d'un jeton fraîchement créé, parce qu'une
 *      invitation et une réinitialisation n'ont pas la même durée de vie et que
 *      `resetPasswordTokenExpiresIn` est un réglage global ;
 *   2. **révoquer** les jetons en cours d'un compte, ce qui est exactement ce
 *      qu'un administrateur veut dire par « annuler cette invitation ».
 *
 * Le préfixe `reset-password:` est un détail interne de la bibliothèque, et
 * c'est assumé comme tel : si une version future le changeait, `extendResetToken`
 * rendrait `null` et l'invitation retomberait à une heure — l'e-mail annoncerait
 * alors honnêtement une heure, parce qu'il lit l'échéance rendue ici et non
 * celle qu'on espérait. Une dégradation visible, pas un mensonge silencieux.
 */
const RESET_TOKEN_PREFIX = 'reset-password:';

function resetTokensOf(userId: string) {
  return and(
    eq(verifications.value, userId),
    sql`${verifications.identifier} like ${`${RESET_TOKEN_PREFIX}%`}`,
  );
}

/**
 * Repousse l'échéance des jetons de réinitialisation en cours d'un compte.
 * Rend la nouvelle échéance, ou `null` si aucune ligne n'a été touchée.
 */
export async function extendResetToken(userId: string, ttlMs: number): Promise<Date | null> {
  const expiresAt = new Date(Date.now() + ttlMs);

  const rows = await getDb()
    .update(verifications)
    .set({ expiresAt, updatedAt: new Date() })
    .where(resetTokensOf(userId))
    .returning({ id: verifications.id });

  if (rows.length === 0) {
    logger.warn(
      { userId },
      'aucun jeton de réinitialisation à prolonger — le format de Better Auth a-t-il changé ?',
    );
    return null;
  }
  return expiresAt;
}

/**
 * Révoque tous les liens en cours d'un compte. Rend le nombre de liens morts.
 *
 * Appelée quand un administrateur annule une invitation, et **avant** d'en
 * renvoyer une : sans cela, deux liens ouvriraient le même compte et le premier
 * survivrait à l'annulation du second.
 */
export async function revokeResetTokens(userId: string): Promise<number> {
  const rows = await getDb()
    .delete(verifications)
    .where(resetTokensOf(userId))
    .returning({ id: verifications.id });
  return rows.length;
}

/** Échéance du lien en cours d'un compte, ou `null` s'il n'y en a aucun de vivant. */
export async function pendingResetTokenExpiry(userId: string): Promise<Date | null> {
  const rows = await getDb()
    .select({ expiresAt: verifications.expiresAt })
    .from(verifications)
    .where(resetTokensOf(userId));

  const now = Date.now();
  const alive = rows
    .map((row) => row.expiresAt)
    .filter((date) => date.getTime() > now)
    .sort((a, b) => b.getTime() - a.getTime());

  return alive[0] ?? null;
}
