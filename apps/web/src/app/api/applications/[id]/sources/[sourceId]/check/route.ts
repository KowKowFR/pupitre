import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiRoute } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { enqueuePoll, sourceOf } from '@/lib/source-routes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid(), sourceId: z.string().uuid() });
type Context = { params: Promise<{ id: string; sourceId: string }> };

/**
 * "Check now": the same check as the next minute's, right away, without an
 * ETag. It only deploys what the link's mode would have deployed by itself.
 */
export const POST = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'application:read');
  const { id, sourceId } = paramsSchema.parse(await context.params);
  await sourceOf(id, sourceId);
  const jobId = await enqueuePoll({ sourceId, force: true, actorId: auth.userId, ip: auth.ip });
  return NextResponse.json({ jobId }, { status: 202 });
});
