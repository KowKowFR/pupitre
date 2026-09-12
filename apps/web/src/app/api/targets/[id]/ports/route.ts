import { getTarget, getTargetPortReport } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

/**
 * État de l'allocation de ports d'une cible : qui occupe quoi, et ce qu'il
 * reste.
 *
 * Lecture seule et dérivée : rien n'est stocké ici que `port_allocations` ne
 * dise déjà. La route existe parce que la question « ce port est pris par qui ? »
 * n'a pas de réponse évidente quand on ne regarde que la table.
 */
export const GET = apiRoute<Context>(async (request, context) => {
  await requirePermission(request, 'target:read');
  const { id } = paramsSchema.parse(await context.params);

  const target = await getTarget(id);
  if (!target) throw new NotFoundError(`Cible « ${id} » introuvable`);

  const report = await getTargetPortReport(id);
  if (!report) throw new NotFoundError(`Cible « ${id} » introuvable`);

  return NextResponse.json(report);
});
