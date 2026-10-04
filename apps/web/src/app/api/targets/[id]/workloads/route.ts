import { encodeWorkloadRef } from '@pupitre/core';
import { getTarget } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { targets as messages } from '@/i18n/messages/targets';
import { NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { fetchWorkloads } from './inventory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

/**
 * Everything that runs on the target — not only what the panel deployed there.
 *
 * Each workload carries its transportable reference and its `managed` marker: it
 * is the driver that answered the question "is it me who set it?", and the panel
 * merely relays it.
 */
export const GET = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'workload:read');
  const { id } = paramsSchema.parse(await context.params);

  const target = await getTarget(id);
  if (!target) throw new NotFoundError(msg(messages, 'error.notFound', { id }));

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
