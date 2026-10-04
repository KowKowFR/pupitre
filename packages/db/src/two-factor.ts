import { and, eq, like, ne } from 'drizzle-orm';
import { getDb, type Database } from './client.js';
import { sessions, twoFactors, users, verifications } from './schema/auth.js';

/**
 * Second factor seen from the administration.
 *
 * Better Auth exposes no path letting a third party remove someone's second
 * factor: `/two-factor/disable` works on the caller's session and requires THEIR
 * password, and the `admin` plugin (ban, set-role, set-user-password,
 * revoke-user-sessions…) does not cover the subject. An administrator therefore
 * has, through the library, no way out for a user who lost their phone AND their
 * backup codes.
 *
 * It is the only reason this module writes directly into Better Auth's tables.
 * It reproduces exactly what `disableTwoFactor` does on the server side — erase
 * the `two_factors` row and set `users.two_factor_enabled` back to false — but in
 * ONE transaction: an account marked "2FA active" without a `two_factors` row
 * can neither sign in nor repair itself; the row without the flag silently
 * blocks any new activation (`enableTwoFactor` refuses as long as a verified row
 * exists). Neither of these two states must be able to arise from a crash
 * halfway.
 */

/** The targeted user does not exist — the route translates it into a 404. */
export class UserNotFoundError extends Error {
  constructor(readonly userId: string) {
    super(`Utilisateur « ${userId} » introuvable`);
    this.name = 'UserNotFoundError';
  }
}

export type TwoFactorState =
  /** No second factor, neither armed nor being configured. */
  | 'none'
  /** Secret generated but never confirmed by a code: sign-in ignores it. */
  | 'pending'
  /** Second factor armed: sign-in asks for a code. */
  | 'active';

/**
 * The second factor state of each user, indexed by id. Crosses the
 * `users.two_factor_enabled` flag and the `two_factors` row: both together,
 * because an inconsistency between them is precisely what an administrator must
 * be able to see then repair.
 */
export async function getTwoFactorStates(
  db: Database = getDb(),
): Promise<Map<string, TwoFactorState>> {
  const rows = await db
    .select({ id: users.id, enabled: users.twoFactorEnabled, verified: twoFactors.verified })
    .from(users)
    .leftJoin(twoFactors, eq(twoFactors.userId, users.id));

  const states = new Map<string, TwoFactorState>();
  for (const row of rows) {
    // The schema does not impose `two_factors.user_id` uniqueness: several rows
    // would give several tuples for the same user, and it is always the most armed
    // one that describes the state experienced at sign-in.
    if (states.get(row.id) === 'active') continue;
    states.set(
      row.id,
      row.enabled || row.verified === true ? 'active' : row.verified === false ? 'pending' : 'none',
    );
  }
  return states;
}

export type TwoFactorResetOptions = {
  /**
   * Session spared by the revocation. Used in case an administrator resets their
   * own second factor: closing it under their feet would send them back to the
   * sign-in screen without a security reason.
   */
  keepSessionId?: string | null;
};

export type TwoFactorResetOutcome = {
  /** State observed before the operation. `none` ⇒ there was nothing to remove. */
  stateBefore: TwoFactorState;
  removedFactors: number;
  revokedSessions: number;
  revokedTrustedDevices: number;
};

/**
 * Removes a user's second factor, without their password.
 *
 * Everything happens in a single transaction: the factor, the flag, the
 * sessions and the trusted devices fall together or not at all.
 */
export async function resetUserTwoFactor(
  userId: string,
  options: TwoFactorResetOptions = {},
  db: Database = getDb(),
): Promise<TwoFactorResetOutcome> {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .select({ enabled: users.twoFactorEnabled })
      .from(users)
      .where(eq(users.id, userId));
    if (!user) throw new UserNotFoundError(userId);

    const existing = await tx
      .select({ verified: twoFactors.verified })
      .from(twoFactors)
      .where(eq(twoFactors.userId, userId));

    const stateBefore: TwoFactorState =
      user.enabled || existing.some((row) => row.verified)
        ? 'active'
        : existing.length > 0
          ? 'pending'
          : 'none';

    if (stateBefore === 'none') {
      return { stateBefore, removedFactors: 0, revokedSessions: 0, revokedTrustedDevices: 0 };
    }

    const removed = await tx
      .delete(twoFactors)
      .where(eq(twoFactors.userId, userId))
      .returning({ id: twoFactors.id });

    await tx
      .update(users)
      .set({ twoFactorEnabled: false, updatedAt: new Date() })
      .where(eq(users.id, userId));

    // A "trusted" device skips the second factor for thirty days. Leaving it alive
    // would survive the reset and make a new factor ineffective on the browser that
    // had remembered it — the proof kept would be that of the factor just removed.
    // Better Auth stores these authorizations in `verifications`, identifier
    // prefixed `trust-device-`, value = the user's id.
    const trusted = await tx
      .delete(verifications)
      .where(
        and(eq(verifications.value, userId), like(verifications.identifier, 'trust-device-%')),
      )
      .returning({ id: verifications.id });

    const keep = options.keepSessionId;
    const revoked = await tx
      .delete(sessions)
      .where(keep ? and(eq(sessions.userId, userId), ne(sessions.id, keep)) : eq(sessions.userId, userId))
      .returning({ id: sessions.id });

    return {
      stateBefore,
      removedFactors: removed.length,
      revokedSessions: revoked.length,
      revokedTrustedDevices: trusted.length,
    };
  });
}
