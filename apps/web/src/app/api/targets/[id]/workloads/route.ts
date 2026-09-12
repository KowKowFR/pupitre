import { encodeWorkloadRef } from '@pupitre/core';
import { getTarget } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { fetchWorkloads } from './inventory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

/**
 * Tout ce qui tourne sur la cible — pas seulement ce que le panel y a déployé.
 *
 * Chaque charge porte sa référence transportable et son marqueur `managed` :
 * c'est le driver qui a répondu à la question « est-ce moi qui l'ai posée ? »,
 * et le panel se contente de la relayer.
 */
export const GET = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'workload:read');
  const { id } = paramsSchema.parse(await context.params);

  const target = await getTarget(id);
  if (!target) throw new NotFoundError(`Cible « ${id} » introuvable`);

  const list = await fetchWorkloads(id, auth.userId, auth.ip);

  return NextResponse.json({
    targetId: list.targetId,
    targetName: target.name,
    checkedAt: list.checkedAt,
    runtimes: list.runtimes,
    items: list.items.map((item) => ({ ...item, ref: encodeWorkloadRef(item) })),
    total: list.items.length,
    managed: list.items.filter((item) => item.managed).length,
  });
});
