import 'server-only';
import {
  and,
  accounts,
  eq,
  getDb,
  isNotNull,
  sql,
  verifications,
  type Database,
} from '@pupitre/db';

/**
 * An account's life-cycle state — **deduced**, never stored.
 *
 * Lives in `lib/` and not in the Route Handler because both read it: the API to
 * return it as JSON, the `/admin/users` screen to show it. A page importing a
 * `route.ts` file would work, but would blur the boundary between what is a route
 * and what is shared code.
 */

/**
 * Where an account stands in its life cycle.
 *
 *   `invited`   created, without a password, an invitation link still valid
 *   `expired`   created, without a password, no valid link any more
 *   `active`    the person chose their password
 *
 * It is not a column: it is a **reading** of two facts that already exist — the
 * existence of an `accounts` row of type `credential`, and that of a live token
 * in `verifications`. Adding a `status` column would create a third truth to keep
 * in agreement with the two others, and it is the one that would end up lying.
 */
export type AccountState = 'invited' | 'expired' | 'active';

/**
 * The state of all the accounts, in two queries.
 *
 * Not one per user: the users list already made a `getUserGrants()` per row, and
 * adding two more would make the screen quadratic for a display detail.
 */
export async function accountStates(
  db: Database = getDb(),
): Promise<Map<string, { hasPassword: boolean; invitationExpiresAt: Date | null }>> {
  const withPassword = await db
    .selectDistinct({ userId: accounts.userId })
    .from(accounts)
    .where(and(eq(accounts.providerId, 'credential'), isNotNull(accounts.password)));

  const pending = await db
    .select({ userId: verifications.value, expiresAt: verifications.expiresAt })
    .from(verifications)
    .where(sql`${verifications.identifier} like 'reset-password:%'`);

  const now = Date.now();
  const passwords = new Set(withPassword.map((row) => row.userId));
  const expiries = new Map<string, Date>();
  for (const row of pending) {
    if (row.expiresAt.getTime() <= now) continue;
    const current = expiries.get(row.userId);
    if (!current || row.expiresAt > current) expiries.set(row.userId, row.expiresAt);
  }

  const all = new Map<string, { hasPassword: boolean; invitationExpiresAt: Date | null }>();
  for (const id of new Set([...passwords, ...expiries.keys()])) {
    all.set(id, { hasPassword: passwords.has(id), invitationExpiresAt: expiries.get(id) ?? null });
  }
  return all;
}

export function accountStateOf(entry?: {
  hasPassword: boolean;
  invitationExpiresAt: Date | null;
}): AccountState {
  if (entry?.hasPassword) return 'active';
  return entry?.invitationExpiresAt ? 'invited' : 'expired';
}

