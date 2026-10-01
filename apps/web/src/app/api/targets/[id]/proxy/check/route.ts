import { PROXY_CHECK_JOB } from '@pupitre/core';
import { getProxyForTarget } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { proxy as messages } from '@/i18n/messages/proxy';
import { HttpError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { getOpsQueue } from '@/lib/queue';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

/** « Tester » : par la file ; le résultat se lit sur la connexion. */
export const POST = apiRoute<Context>(async (request, context) => {
  await requirePermission(request, 'target:update');
  const { id } = paramsSchema.parse(await context.params);
  const proxy = await getProxyForTarget(id);
  if (!proxy) throw new NotFoundError(msg(messages, 'error.targetNotFound'));
  const job = await getOpsQueue().add(PROXY_CHECK_JOB, { proxyId: proxy.id });
  if (!job.id) throw new HttpError(500, 'enqueue_failed', msg(messages, 'error.jobNoId'));
  return NextResponse.json({ jobId: job.id }, { status: 202 });
});
