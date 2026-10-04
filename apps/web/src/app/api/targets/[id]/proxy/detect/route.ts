import { PROXY_DETECT_JOB } from '@pupitre/core';
import { getTarget } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { proxy as messages } from '@/i18n/messages/proxy';
import { HttpError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { opsQueueEvents } from '@/lib/proxy';
import { getOpsQueue } from '@/lib/queue';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

/**
 * Looking at the machine: the proxies already there, and what Pupitre could
 * install. The panel opens no SSH session — the question goes through the worker,
 * and the route waits for its answer, as for the host metrics.
 *
 * 60 seconds: a few SSH commands (one per container found), plus waiting in the
 * queue behind a deployment in progress. Beyond that, a plain 504.
 */
const DETECT_TIMEOUT_MS = 60_000;

export const POST = apiRoute<Context>(async (request, context) => {
  await requirePermission(request, 'target:update');
  const { id } = paramsSchema.parse(await context.params);
  if (!(await getTarget(id))) throw new NotFoundError(msg(messages, 'error.targetNotFound'));

  const job = await getOpsQueue().add(PROXY_DETECT_JOB, { targetId: id }, { attempts: 1 });
  try {
    const result: unknown = await job.waitUntilFinished(opsQueueEvents(), DETECT_TIMEOUT_MS);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/timed out/i.test(message)) {
      throw new HttpError(504, 'proxy_detect_timeout', msg(messages, 'error.detectTimeout'));
    }
    throw new HttpError(
      502,
      'proxy_detect_failed',
      msg(messages, 'error.detectFailed', { error: message }),
    );
  }
});
