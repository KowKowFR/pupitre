import { and, count, desc, eq, gt, isNull, lt, or } from 'drizzle-orm';
import { getDb, type Database } from './client.js';
import { apiTokens, type ApiTokenRow } from './schema/api-tokens.js';
import { users } from './schema/auth.js';

/**
 * API tokens in the database. This module never sees a token in clear: it stores
 * and finds hashes. Making the token and reading it in the `Authorization`
 * header belong to the panel.
 */

export type ApiTokenView = Omit<ApiTokenRow, 'tokenHash'> & {
  ownerEmail: string;
  ownerName: string;
};

const viewColumns = {
  id: apiTokens.id,
  userId: apiTokens.userId,
  name: apiTokens.name,
  prefix: apiTokens.prefix,
  permissions: apiTokens.permissions,
  applicationIds: apiTokens.applicationIds,
  expiresAt: apiTokens.expiresAt,
  lastUsedAt: apiTokens.lastUsedAt,
  lastUsedIp: apiTokens.lastUsedIp,
  revokedAt: apiTokens.revokedAt,
  createdAt: apiTokens.createdAt,
  ownerEmail: users.email,
  ownerName: users.name,
};

export async function createApiToken(
  input: {
    userId: string;
    name: string;
    prefix: string;
    tokenHash: string;
    permissions: string[];
    applicationIds: string[] | null;
    expiresAt: Date | null;
  },
  db: Database = getDb(),
): Promise<ApiTokenRow> {
  const [row] = await db.insert(apiTokens).values(input).returning();
  if (!row) throw new Error('the API token was not saved');
  return row;
}

/** A person's tokens, or the whole instance's (`userId` absent) — revoked ones included. */
export async function listApiTokens(
  filter: { userId?: string } = {},
  db: Database = getDb(),
): Promise<ApiTokenView[]> {
  return db
    .select(viewColumns)
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(filter.userId ? eq(apiTokens.userId, filter.userId) : undefined)
    .orderBy(desc(apiTokens.createdAt));
}

export async function getApiToken(
  id: string,
  db: Database = getDb(),
): Promise<ApiTokenView | null> {
  const [row] = await db
    .select(viewColumns)
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(eq(apiTokens.id, id));
  return row ?? null;
}

/** A person's tokens still in service: neither revoked nor expired. */
export async function countLiveApiTokens(userId: string, db: Database = getDb()): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(apiTokens)
    .where(
      and(
        eq(apiTokens.userId, userId),
        isNull(apiTokens.revokedAt),
        or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, new Date())),
      ),
    );
  return row?.value ?? 0;
}

/** Revokes a token. Returns `false` if it already was, or if it does not exist. */
export async function revokeApiToken(id: string, db: Database = getDb()): Promise<boolean> {
  const rows = await db
    .update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiTokens.id, id), isNull(apiTokens.revokedAt)))
    .returning({ id: apiTokens.id });
  return rows.length > 0;
}

/**
 * The token carrying this hash, with what is needed of its author to decide: is
 * their account still active? Revoked or expired, it is returned as is — it is
 * the caller that refuses, and says so in the log.
 */
export async function findApiTokenByHash(
  tokenHash: string,
  db: Database = getDb(),
): Promise<{
  token: ApiTokenRow;
  user: {
    id: string;
    email: string;
    name: string;
    image: string | null;
    banned: boolean;
    twoFactorEnabled: boolean;
  };
} | null> {
  const [row] = await db
    .select({
      token: apiTokens,
      user: {
        id: users.id,
        email: users.email,
        name: users.name,
        image: users.image,
        banned: users.banned,
        twoFactorEnabled: users.twoFactorEnabled,
      },
    })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(eq(apiTokens.tokenHash, tokenHash));
  return row ?? null;
}

/** How long a last use stays "fresh": one write per minute at most. */
const TOUCH_EVERY_MS = 60_000;

/**
 * Notes a token's last use. A CI calling the API ten times per deployment must
 * not cost ten writes: one per minute is enough to say "used just now".
 */
export async function touchApiToken(
  id: string,
  ip: string | null,
  db: Database = getDb(),
): Promise<void> {
  const stale = new Date(Date.now() - TOUCH_EVERY_MS);
  await db
    .update(apiTokens)
    .set({ lastUsedAt: new Date(), lastUsedIp: ip })
    .where(
      and(eq(apiTokens.id, id), or(isNull(apiTokens.lastUsedAt), lt(apiTokens.lastUsedAt, stale))),
    );
}
