import { LOCKED_ROLE, type RoleKey } from '@pupitre/core';
import {
  asc,
  count,
  eq,
  getDb,
  getRoleByKey,
  getTwoFactorStates,
  getUserGrants,
  logAudit,
  roleKeySchema,
  setUserRoles,
  userRoles,
  users,
  type TwoFactorState,
} from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { captureAccountMail, mailChannelName } from '@/lib/account-mail';
import { accountStateOf, accountStates, type AccountState } from '@/lib/account-state';
import { INVITATION_PATH, getAuth } from '@/lib/auth';
import { ConflictError, HttpError, NotFoundError } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { PASSWORD_MIN_LENGTH } from '@/lib/password-policy';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export type AdminUser = {
  id: string;
  name: string;
  email: string;
  banned: boolean;
  banReason: string | null;
  roles: RoleKey[];
  /** Second facteur : sans lui, réinitialiser serait un bouton actionné à l'aveugle. */
  twoFactor: TwoFactorState;
  /** Où en est le compte : invité, invitation périmée, ou actif. */
  state: AccountState;
  /** Échéance du lien en cours, quand il y en a un. Jamais le lien lui-même. */
  invitationExpiresAt: string | null;
  /** L'adresse a été prouvée — la personne a cliqué sur un lien qui y était envoyé. */
  emailVerified: boolean;
  createdAt: string;
};

export const GET = apiRoute(async (request) => {
  await requirePermission(request, 'user:read');

  const db = getDb();
  const rows = await db.select().from(users).orderBy(asc(users.createdAt));
  const grants = await Promise.all(rows.map((row) => getUserGrants(row.id, db)));
  const twoFactor = await getTwoFactorStates(db);
  const states = await accountStates(db);

  const items: AdminUser[] = rows.map((row, index) => {
    const state = states.get(row.id);
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      banned: row.banned,
      banReason: row.banReason,
      roles: grants[index]?.roles ?? [],
      twoFactor: twoFactor.get(row.id) ?? 'none',
      state: accountStateOf(state),
      invitationExpiresAt: state?.invitationExpiresAt?.toISOString() ?? null,
      emailVerified: row.emailVerified,
      createdAt: row.createdAt.toISOString(),
    };
  });

  return NextResponse.json({ items, total: items.length });
});

/**
 * ## Inviter, ou fabriquer un mot de passe : une seule route, deux régimes
 *
 * `password` absent → **invitation**. Le compte est créé sans aucun mot de
 * passe (pas même un aléatoire jeté ensuite : Better Auth crée la ligne
 * `credential` au moment du `reset-password`, donc il n'y a rien à jeter), et
 * la personne reçoit un lien pour en choisir un. Personne d'autre ne le connaît
 * jamais — pas même celui qui a invité.
 *
 * `password` présent → **création directe**, l'ancien comportement.
 *
 * ### Pourquoi les deux survivent
 *
 * Le supprimer casserait le seul chemin qui fonctionne sur une instance
 * neuve : tant qu'aucun canal SMTP n'est configuré — l'état par défaut —, aucun
 * e-mail ne peut partir, et l'assistant de démarrage doit pourtant pouvoir
 * créer un compte. C'est aussi le seul chemin utilisable par un script.
 *
 * Ce qui disparaît, c'est le **choix** : l'écran `/admin/users` n'affiche qu'un
 * seul formulaire, et c'est la capacité de l'instance qui décide lequel. Un
 * opérateur ne voit jamais deux façons de faire la même chose ; l'API, elle, en
 * garde deux, parce qu'elle sert aussi ceux qui n'ont pas d'écran.
 */
const createUserSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email().max(200),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(200).optional(),
  role: roleKeySchema.default('viewer'),
});

export const POST = apiRoute(async (request) => {
  const auth = await requirePermission(request, 'user:manage');
  const input = await readJsonBody(request, createUserSchema);
  const invite = input.password === undefined;

  const db = getDb();
  const [existing] = await db
    .select({ value: count() })
    .from(users)
    .where(eq(users.email, input.email));
  if ((existing?.value ?? 0) > 0) {
    throw new ConflictError(`Un compte existe déjà pour ${input.email}`);
  }

  if (!(await getRoleByKey(input.role, db))) {
    throw new NotFoundError(`Rôle « ${input.role} » introuvable`);
  }

  // La capacité est vérifiée **avant** de créer quoi que ce soit : un compte
  // invité qui ne recevra jamais son invitation est un compte qu'il faudra
  // supprimer à la main.
  const channel = invite ? await mailChannelName() : null;
  if (invite && !channel) {
    throw new HttpError(
      409,
      'mail_channel_missing',
      'Aucun canal e-mail (SMTP) actif : l’invitation ne pourrait pas partir. ' +
        'Configurez-en un dans Paramètres → Notifications, ou créez le compte avec un mot de passe.',
    );
  }

  // Passe par Better Auth pour que le mot de passe soit haché comme à
  // l'inscription. Son plugin admin ne connaît que son propre vocabulaire de
  // rôles : on crée donc le compte avec le moins privilégié qu'il accepte, puis
  // on pose le rôle réel par notre couche, qui est l'autorité. Sans ce détour,
  // créer un utilisateur avec un rôle personnalisé serait refusé par Better Auth.
  const created = await getAuth().api.createUser({
    body: {
      name: input.name,
      email: input.email,
      // Champ omis pour une invitation : le compte naît sans mot de passe.
      ...(input.password === undefined ? {} : { password: input.password }),
      role: 'viewer',
    },
    // Better Auth revérifie de son côté que l'appelant est administrateur.
    headers: request.headers,
  });

  await setUserRoles(created.user.id, [input.role], db);

  await logAudit({
    actorId: auth.userId,
    action: 'user.created.by_admin',
    resourceType: 'user',
    resourceId: created.user.id,
    // `method` distingue les deux régimes dans le journal. Sans lui, on ne
    // saurait pas, six mois plus tard, si un mot de passe a un jour transité
    // par un canal humain.
    after: {
      email: input.email,
      name: input.name,
      role: input.role,
      method: invite ? 'invitation' : 'password',
    },
    ip: auth.ip,
  });

  let invitation: { sent: boolean; channel: string | null; error: string | null } | null = null;

  if (invite) {
    invitation = await inviteExistingUser({
      userId: created.user.id,
      email: input.email,
      actorId: auth.userId,
      actorEmail: auth.email,
      ip: auth.ip,
      headers: request.headers,
      resend: false,
    });
  }

  return NextResponse.json(
    {
      id: created.user.id,
      email: created.user.email,
      name: created.user.name,
      roles: [input.role],
      invitation,
    },
    { status: 201 },
  );
});

/**
 * Fabrique le lien, l'envoie, trace — pour un compte qui existe déjà.
 *
 * Partagé entre la création par invitation et le bouton « Relancer » de
 * `/admin/users`, parce que ce sont **exactement** les mêmes gestes : la
 * deuxième invitation n'est pas une invitation au rabais.
 *
 * L'échec d'envoi n'annule pas le compte et ne renvoie pas d'erreur HTTP : il
 * est rapporté dans la réponse. Créer le compte puis le détruire parce que le
 * serveur SMTP a hoqueté serait un remède pire que le mal — la personne
 * apparaît dans la liste avec l'état « invitation à relancer », ce qu'un
 * administrateur sait traiter.
 */
export async function inviteExistingUser(options: {
  userId: string;
  email: string;
  actorId: string;
  actorEmail: string;
  ip: string | null;
  headers: Headers;
  resend: boolean;
}): Promise<{ sent: boolean; channel: string | null; error: string | null }> {
  let sent = false;
  let channel: string | null = null;
  let error: string | null = null;

  try {
    // `captureAccountMail` ouvre le contexte qui fait **attendre** l'envoi :
    // un administrateur qui invite doit savoir si le message est parti, pas
    // qu'il est enfilé. Le formulaire public de réinitialisation, lui, n'ouvre
    // aucun contexte — il ne doit rien attendre. Voir `@/lib/account-mail`.
    const { verdict } = await captureAccountMail(() =>
      getAuth().api.requestPasswordReset({
        // `redirectTo` ne décide pas du texte de l'e-mail — c'est l'état du
        // compte qui le décide, côté serveur. Il est passé pour que le GET de
        // vérification du jeton ait une destination si jamais la réécriture de
        // `withLanding()` n'avait pas lieu.
        body: { email: options.email, redirectTo: INVITATION_PATH },
        headers: options.headers,
      }),
    );
    sent = verdict?.delivered === true;
    channel = verdict?.channel ?? null;
    error = verdict?.error ?? (verdict ? null : 'aucun e-mail déclenché');
  } catch (caught) {
    error = caught instanceof HttpError ? caught.message : 'envoi impossible';
  }

  await logAudit({
    actorId: options.actorId,
    action: options.resend ? 'user.invitation.resent' : 'user.invited',
    resourceType: 'user',
    resourceId: options.userId,
    // Aucun jeton, aucun lien : la trace dit qui a invité qui, par quel canal,
    // et si c'est parti. Elle n'ouvre aucun compte.
    after: { email: options.email, invitedBy: options.actorEmail, sent, channel, error },
    ip: options.ip,
  });

  return { sent, channel, error };
}

/** Nombre d'administrateurs actifs — sert à interdire de retirer le dernier. */
export async function countActiveAdmins(excludeUserId?: string): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ userId: userRoles.userId, banned: users.banned, role: users.role })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId));

  return rows.filter(
    (row) => row.role === LOCKED_ROLE && !row.banned && row.userId !== excludeUserId,
  ).length;
}
