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
 * The worst case: four seconds of DNS, then eight of RDAP in parallel with six of
 * TLS. The margin covers waiting in the queue; beyond that, it is the worker that
 * is not consuming, and the caller deserves a plain 504.
 */
const INSPECT_TIMEOUT_MS = 25_000;

/**
 * Each reading queries an RDAP registry, which also rate-limits: a drawer opened
 * and closed in a loop must not get the instance banned.
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
 * A domain's reading: DNS, addresses, RDAP, certificate — seen from the worker,
 * at the instant. A read: the route queues and waits, it executes nothing (rule
 * 2). Nothing is written, neither to the log nor on the route.
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
