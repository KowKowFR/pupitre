import { getTarget } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { targets as messages } from '@/i18n/messages/targets';
import { NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { fetchHostMetrics } from './probe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

/**
 * How the machine is doing — load, memory, disk, uptime, kernel.
 *
 * `target:read` is enough: reading the state of a machine one is already allowed
 * to see opens no new power. Nothing is written, neither on the target nor in the
 * database: the reading is true at the second it is taken and disappears with the
 * response.
 *
 * An unreachable target returns **200 with `reachable:false`**, not an error: "I
 * could not reach this machine, here is why" is a valid answer, and the screen
 * must be able to show it without losing the rest of the row.
 */
export const GET = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'target:read');
  const { id } = paramsSchema.parse(await context.params);

  const target = await getTarget(id);
  if (!target) throw new NotFoundError(msg(messages, 'error.notFound', { id }));

  const metrics = await fetchHostMetrics(id, auth.userId, auth.ip);

  return NextResponse.json({ ...metrics, targetName: target.name });
});
