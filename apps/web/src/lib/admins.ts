import 'server-only';
import { LOCKED_ROLE } from '@pupitre/core';
import { eq, getDb, userRoles, users } from '@pupitre/db';

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
