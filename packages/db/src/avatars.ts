import { createHash } from 'node:crypto';
import type { ImageMediaType } from '@pupitre/core';
import { eq } from 'drizzle-orm';
import { getDb, type Database } from './client.js';
import { users } from './schema/auth.js';
import { userAvatars } from './schema/avatars.js';

/**
 * Les photos de profil. L'URL rangée dans `users.image` porte une version tirée
 * du contenu : une nouvelle photo, une nouvelle URL, et l'ancienne peut rester
 * en cache sans jamais être resservie à tort.
 */

export function avatarUrl(userId: string, data: Buffer): string {
  const version = createHash('sha256').update(data).digest('hex').slice(0, 12);
  return `/api/users/${encodeURIComponent(userId)}/avatar?v=${version}`;
}

export async function setUserAvatar(
  userId: string,
  avatar: { contentType: ImageMediaType; width: number; height: number; data: Buffer },
  db: Database = getDb(),
): Promise<string> {
  const url = avatarUrl(userId, avatar.data);
  const values = { ...avatar, bytes: avatar.data.byteLength, updatedAt: new Date() };
  await db.transaction(async (tx) => {
    await tx
      .insert(userAvatars)
      .values({ userId, ...values })
      .onConflictDoUpdate({ target: userAvatars.userId, set: values });
    await tx.update(users).set({ image: url, updatedAt: new Date() }).where(eq(users.id, userId));
  });
  return url;
}

/** Retire la photo. Rend `false` s'il n'y en avait pas. */
export async function removeUserAvatar(userId: string, db: Database = getDb()): Promise<boolean> {
  return db.transaction(async (tx) => {
    const removed = await tx
      .delete(userAvatars)
      .where(eq(userAvatars.userId, userId))
      .returning({ userId: userAvatars.userId });
    await tx.update(users).set({ image: null, updatedAt: new Date() }).where(eq(users.id, userId));
    return removed.length > 0;
  });
}

/** Les octets de la photo, pour la route qui la sert — et elle seule. */
export async function getUserAvatar(
  userId: string,
  db: Database = getDb(),
): Promise<{ contentType: ImageMediaType; bytes: number; data: Buffer } | null> {
  const [row] = await db
    .select({
      contentType: userAvatars.contentType,
      bytes: userAvatars.bytes,
      data: userAvatars.data,
    })
    .from(userAvatars)
    .where(eq(userAvatars.userId, userId));
  return row ?? null;
}
