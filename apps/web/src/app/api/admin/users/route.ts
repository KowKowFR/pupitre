import { translator, type RoleKey } from '@pupitre/core';
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
  users,
  type TwoFactorState,
} from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { captureAccountMail, mailChannelName } from '@/lib/account-mail';
import { accountStateOf, accountStates, type AccountState } from '@/lib/account-state';
import { INVITATION_PATH, getAuth } from '@/lib/auth';
import { admin } from '@/i18n/messages/admin';
import { currentLanguage } from '@/i18n/server';
import { ConflictError, HttpError, NotFoundError, msg } from '@/lib/errors';
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
  /** Second factor: without it, resetting would be a button pressed blindly. */
  twoFactor: TwoFactorState;
  /** Where the account stands: invited, expired invitation, or active. */
  state: AccountState;
  /** The current link's expiry, when there is one. Never the link itself. */
  invitationExpiresAt: string | null;
  /** The address was proven — the person clicked a link sent to it. */
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
 * ## Inviting, or making up a password: a single route, two regimes
 *
 * `password` absent → **invitation**. The account is created without any password
 * (not even a random one thrown away afterwards: Better Auth creates the
 * `credential` row at `reset-password` time, so there is nothing to throw away),
 * and the person receives a link to choose one. Nobody else ever knows it — not
 * even whoever invited.
 *
 * `password` present → **direct creation**, the old behavior.
 *
 * ### Why both survive
 *
 * Removing it would break the only path that works on a new instance: as long as
 * no SMTP channel is configured — the default state —, no email can go out, and
 * the onboarding assistant must still be able to create an account. It is also
 * the only path usable by a script.
 *
 * What disappears is the **choice**: the `/admin/users` screen only shows one
 * form, and it is the instance's capability that decides which. An operator
 * never sees two ways of doing the same thing; the API, for its part, keeps two,
 * because it also serves those who have no screen.
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
    throw new ConflictError(msg(admin, 'error.user.emailTaken', { email: input.email }));
  }

  if (!(await getRoleByKey(input.role, db))) {
    throw new NotFoundError(msg(admin, 'error.role.notFound', { key: input.role }));
  }

  // The capability is checked **before** creating anything: an invited account
  // that will never receive its invitation is an account that will have to be
  // deleted by hand.
  const channel = invite ? await mailChannelName() : null;
  if (invite && !channel) {
    throw new HttpError(
      409,
      'mail_channel_missing',
      msg(admin, 'error.mail.missing.create'),
    );
  }

  // Goes through Better Auth so that the password is hashed as at sign-up. Its
  // admin plugin only knows its own role vocabulary: so we create the account with
  // the least privileged one it accepts, then set the real role through our layer,
  // which is the authority. Without this detour, creating a user with a custom
  // role would be refused by Better Auth.
  const created = await getAuth().api.createUser({
    body: {
      name: input.name,
      email: input.email,
      // Field omitted for an invitation: the account is born without a password.
      ...(input.password === undefined ? {} : { password: input.password }),
      role: 'viewer',
    },
    // Better Auth checks again on its side that the caller is an administrator.
    headers: request.headers,
  });

  await setUserRoles(created.user.id, [input.role], db);

  await logAudit({
    actorId: auth.userId,
    action: 'user.created.by_admin',
    resourceType: 'user',
    resourceId: created.user.id,
    // `method` tells the two regimes apart in the log. Without it, one would not
    // know, six months later, whether a password ever went through a human channel.
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
 * Makes the link, sends it, traces — for an account that already exists.
 *
 * Shared between creation by invitation and `/admin/users`' "Resend" button,
 * because they are **exactly** the same gestures: the second invitation is not a
 * cut-price invitation.
 *
 * The sending's failure does not cancel the account and does not return an HTTP
 * error: it is reported in the response. Creating the account then destroying it
 * because the SMTP server hiccupped would be a cure worse than the disease — the
 * person appears in the list with the "invitation to resend" state, which an
 * administrator knows how to handle.
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
  // The two verdicts below are rendered as is in `/admin/users`' banner: they
  // therefore follow the instance's language, like the rest.
  const t = translator(admin, await currentLanguage());

  let sent = false;
  let channel: string | null = null;
  let error: string | null = null;

  try {
    // `captureAccountMail` opens the context that makes the sending **awaited**: an
    // administrator who invites must know whether the message went out, not that it
    // is queued. The public reset form, for its part, opens no context — it must not
    // wait for anything. See `@/lib/account-mail`.
    const { verdict } = await captureAccountMail(() =>
      getAuth().api.requestPasswordReset({
        // `redirectTo` does not decide the email's text — it is the account's state that
        // decides it, on the server side. It is passed so that the token's verification
        // GET has a destination if ever `withLanding()`'s rewriting did not take place.
        body: { email: options.email, redirectTo: INVITATION_PATH },
        headers: options.headers,
      }),
    );
    sent = verdict?.delivered === true;
    channel = verdict?.channel ?? null;
    error = verdict?.error ?? (verdict ? null : t('mail.notTriggered'));
  } catch (caught) {
    error = caught instanceof HttpError ? caught.message : t('mail.sendFailed');
  }

  await logAudit({
    actorId: options.actorId,
    action: options.resend ? 'user.invitation.resent' : 'user.invited',
    resourceType: 'user',
    resourceId: options.userId,
    // No token, no link: the trace says who invited whom, through which channel, and
    // whether it went out. It opens no account.
    after: { email: options.email, invitedBy: options.actorEmail, sent, channel, error },
    ip: options.ip,
  });

  return { sent, channel, error };
}
