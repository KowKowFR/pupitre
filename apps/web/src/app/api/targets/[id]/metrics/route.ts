import { getTarget } from '@tp/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { fetchHostMetrics } from './probe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

/**
 * Comment se porte la machine — charge, mémoire, disque, uptime, noyau.
 *
 * `target:read` suffit : lire l'état d'une machine qu'on a déjà le droit de
 * voir n'ouvre aucun pouvoir nouveau. Rien n'est écrit, ni sur la cible, ni en
 * base : le relevé est vrai à la seconde où il est pris et disparaît avec la
 * réponse.
 *
 * Une cible injoignable rend **200 avec `reachable:false`**, pas une erreur :
 * « je n'ai pas pu joindre cette machine, voici pourquoi » est une réponse
 * valide, et l'écran doit pouvoir l'afficher sans perdre le reste de la ligne.
 */
export const GET = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'target:read');
  const { id } = paramsSchema.parse(await context.params);

  const target = await getTarget(id);
  if (!target) throw new NotFoundError(`Cible « ${id} » introuvable`);

  const metrics = await fetchHostMetrics(id, auth.userId, auth.ip);

  return NextResponse.json({ ...metrics, targetName: target.name });
});
