import { translator } from '@pupitre/core';
import { eq, getDb, getUserGrants, logAudit, sessions, users } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { revokeResetTokens } from '@/lib/auth';
import { admin } from '@/i18n/messages/admin';
import { currentLanguage } from '@/i18n/server';
import { ConflictError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { countActiveAdmins } from '@/lib/admins';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().min(1).max(200) });
const bodySchema = z.object({
  banned: z.boolean(),
  reason: z.string().min(1).max(500).optional(),
});

type Context = { params: Promise<{ id: string }> };

/** Enabling / disabling an account. */
export const PATCH = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'user:manage');
  const { id } = paramsSchema.parse(await context.params);
  const { banned, reason } = await readJsonBody(request, bodySchema);
  const t = translator(admin, await currentLanguage());

  if (id === auth.userId) {
    throw new ConflictError(msg(admin, 'error.user.disableSelf'));
  }

  const db = getDb();
  const [target] = await db.select().from(users).where(eq(users.id, id));
  if (!target) throw new NotFoundError(msg(admin, 'error.user.notFound', { id }));

  if (banned) {
    const grants = await getUserGrants(id, db);
    if (grants.roles.includes('admin') && (await countActiveAdmins(id)) === 0) {
      throw new ConflictError(msg(admin, 'error.user.lastAdmin.disable'));
    }
  }

  await db
    .update(users)
    .set({
      banned,
      banReason: banned ? (reason ?? t('users.banReason.default')) : null,
      banExpires: null,
      updatedAt: new Date(),
    })
    .where(eq(users.id, id));

  // A disabled account loses its current sessions — and its current links. An
  // invitation that survives the deactivation is a door one believes closed: it
  // would not give access back (sign-in stays refused), but it would let someone
  // set a password on an account that was just suspended. Re-enabling resends an
  // invitation, which is the explicit gesture one wants to see in the log.
  let revokedLinks = 0;
  if (banned) {
    await db.delete(sessions).where(eq(sessions.userId, id));
    revokedLinks = await revokeResetTokens(id);
  }

  await logAudit({
    actorId: auth.userId,
    action: banned ? 'user.disabled' : 'user.enabled',
    resourceType: 'user',
    resourceId: id,
    before: { banned: target.banned },
    after: { banned, reason: reason ?? null, email: target.email, revokedLinks },
    ip: auth.ip,
  });

  return NextResponse.json({ id, banned, revokedLinks });
});
