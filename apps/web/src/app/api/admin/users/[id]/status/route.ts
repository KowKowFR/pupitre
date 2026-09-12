import { eq, getDb, getUserGrants, logAudit, sessions, users } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { revokeResetTokens } from '@/lib/auth';
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

  // Un compte désactivé perd ses sessions en cours — et ses liens en cours.
  // Une invitation qui survit à la désactivation, c'est une porte qu'on croit
  // avoir fermée : elle ne rendrait pas l'accès (la connexion reste refusée),
  // mais elle laisserait quelqu'un poser un mot de passe sur un compte qu'on
  // vient de suspendre. Réactiver relance une invitation, ce qui est le geste
  // explicite qu'on veut voir dans le journal.
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
