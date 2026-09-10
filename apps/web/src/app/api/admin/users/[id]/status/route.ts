import { eq, getDb, getUserGrants, logAudit, sessions, users } from '@tp/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ConflictError, NotFoundError } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { countActiveAdmins } from '../../route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().min(1).max(200) });
const bodySchema = z.object({
  banned: z.boolean(),
  reason: z.string().min(1).max(500).optional(),
});

type Context = { params: Promise<{ id: string }> };

/** Activation / désactivation d'un compte. */
export const PATCH = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'user:manage');
  const { id } = paramsSchema.parse(await context.params);
  const { banned, reason } = await readJsonBody(request, bodySchema);

  if (id === auth.userId) {
    throw new ConflictError('Impossible de désactiver son propre compte');
  }

  const db = getDb();
  const [target] = await db.select().from(users).where(eq(users.id, id));
  if (!target) throw new NotFoundError(`Utilisateur « ${id} » introuvable`);

  if (banned) {
    const grants = await getUserGrants(id, db);
    if (grants.roles.includes('admin') && (await countActiveAdmins(id)) === 0) {
      throw new ConflictError(
        'Impossible de désactiver le dernier administrateur actif de la plateforme',
      );
    }
  }

  await db
    .update(users)
    .set({
      banned,
      banReason: banned ? (reason ?? 'Désactivé par un administrateur') : null,
      banExpires: null,
      updatedAt: new Date(),
    })
    .where(eq(users.id, id));

  // Un compte désactivé perd ses sessions en cours.
  if (banned) {
    await db.delete(sessions).where(eq(sessions.userId, id));
  }

  await logAudit({
    actorId: auth.userId,
    action: banned ? 'user.disabled' : 'user.enabled',
    resourceType: 'user',
    resourceId: id,
    before: { banned: target.banned },
    after: { banned, reason: reason ?? null, email: target.email },
    ip: auth.ip,
  });

  return NextResponse.json({ id, banned });
});
