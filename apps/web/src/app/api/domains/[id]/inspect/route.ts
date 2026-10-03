import {
  DOMAIN_INSPECT_JOB,
  SUPERVISION_QUEUE,
  domainInspectJobDataSchema,
  domainInspectionSchema,
} from '@pupitre/core';
import { getRouteById } from '@pupitre/db';
import { QueueEvents } from 'bullmq';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { domains as messages } from '@/i18n/messages/domains';
import { HttpError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { enforceRateLimit, type RateLimitRule } from '@/lib/rate-limit';
import { requirePermission } from '@/lib/rbac';
import { getRedis } from '@/lib/redis';
import { getSupervisionQueue } from '@/lib/supervision-queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Le pire cas : quatre secondes de DNS, puis huit de RDAP en parallèle de six
 * de TLS. La marge couvre l'attente en file ; au-delà, c'est le worker qui ne
 * consomme pas, et l'appelant mérite un 504 franc.
 */
const INSPECT_TIMEOUT_MS = 25_000;

/**
 * Chaque relevé interroge un registre RDAP, qui limite lui aussi : un tiroir
 * qu'on ouvre et referme en boucle ne doit pas faire bannir l'instance.
 */
const INSPECT_RULE: RateLimitRule = { name: 'domain:inspect', limit: 30, windowSec: 300 };

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

declare global {
  var __tpDomainInspectQueueEvents: QueueEvents | undefined;
}

function queueEvents(): QueueEvents {
  globalThis.__tpDomainInspectQueueEvents ??= new QueueEvents(SUPERVISION_QUEUE, {
    connection: getRedis(),
  });
  return globalThis.__tpDomainInspectQueueEvents;
}

/**
 * Le relevé d'un domaine : DNS, adresses, RDAP, certificat — vus du worker,
 * à l'instant. Une lecture : la route enfile et attend, elle n'exécute rien
 * (règle 2). Rien n'est écrit, ni au journal ni sur la route.
 */
export const GET = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'application:read');
  const { id } = paramsSchema.parse(await context.params);
  if (!(await getRouteById(id))) throw new NotFoundError(msg(messages, 'error.notFound'));
  await enforceRateLimit(INSPECT_RULE, auth.userId);

  const job = await getSupervisionQueue().add(
    DOMAIN_INSPECT_JOB,
    domainInspectJobDataSchema.parse({ routeId: id }),
    { attempts: 1 },
  );

  let raw: unknown;
  try {
    raw = await job.waitUntilFinished(queueEvents(), INSPECT_TIMEOUT_MS);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/timed out/i.test(message)) {
      throw new HttpError(504, 'domain_inspect_timeout', msg(messages, 'error.timeout'));
    }
    throw new HttpError(502, 'domain_inspect_failed', msg(messages, 'error.failed', { message }));
  }

  const parsed = domainInspectionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(502, 'domain_inspect_failed', msg(messages, 'error.unreadable'));
  }
  return NextResponse.json(parsed.data);
});
