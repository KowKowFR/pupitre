import { getDb, eq, logAudit, removeUserAvatar, users } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { admin } from '@/i18n/messages/admin';
import { NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().min(1).max(200) });
type Context = { params: Promise<{ id: string }> };

/**
 * Retirer la photo de quelqu'un d'autre — la modération d'une image
 * déplacée. `user:manage`, tracé au journal avec le nom de la personne.
 */
export const DELETE = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'user:manage');
  const { id } = paramsSchema.parse(await context.params);

  const [user] = await getDb().select({ email: users.email }).from(users).where(eq(users.id, id));
  if (!user) throw new NotFoundError(msg(admin, 'error.user.notFound', { id }));

  const removed = await removeUserAvatar(id);
  if (removed) {
    await logAudit({
      actorId: auth.userId,
      action: 'user.avatar.removed',
      resourceType: 'user',
      resourceId: id,
      after: { email: user.email },
      ip: auth.ip,
    });
  }
  return NextResponse.json({ removed });
});
