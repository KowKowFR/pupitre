import { and, count, desc, eq, gt, isNull, lt, or } from 'drizzle-orm';
import { getDb, type Database } from './client.js';
import { apiTokens, type ApiTokenRow } from './schema/api-tokens.js';
import { users } from './schema/auth.js';

/**
 * Les jetons d'API en base. Ce module ne voit jamais un jeton en clair : il
 * range et retrouve des empreintes. La fabrication du jeton et sa lecture dans
 * l'en-tête `Authorization` appartiennent au panel.
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
  if (!row) throw new Error("le jeton d'API n'a pas été enregistré");
  return row;
}

/** Les jetons d'une personne, ou de toute l'instance (`userId` absent) — révoqués compris. */
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

/** Les jetons encore en service d'une personne : ni révoqués, ni échus. */
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

/** Révoque un jeton. Rend `false` s'il l'était déjà, ou s'il n'existe pas. */
export async function revokeApiToken(id: string, db: Database = getDb()): Promise<boolean> {
  const rows = await db
    .update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiTokens.id, id), isNull(apiTokens.revokedAt)))
    .returning({ id: apiTokens.id });
  return rows.length > 0;
}

/**
 * Le jeton qui porte cette empreinte, avec ce qu'il faut de son auteur pour
 * décider : son compte est-il encore actif ? Révoqué ou échu, il est rendu tel
 * quel — c'est l'appelant qui refuse, et qui le dit au journal.
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

/** Combien de temps une dernière utilisation reste « fraîche » : une écriture par minute au plus. */
const TOUCH_EVERY_MS = 60_000;

/**
 * Note la dernière utilisation d'un jeton. Une CI qui appelle l'API dix fois
 * par déploiement ne doit pas coûter dix écritures : une par minute suffit à
 * dire « utilisé à l'instant ».
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
