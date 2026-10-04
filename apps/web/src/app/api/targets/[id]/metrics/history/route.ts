import {
  HOST_SAMPLE_INTERVAL_SECONDS,
  HOST_SAMPLE_RETENTION_DAYS,
  getTarget,
  listOpenBreaches,
  resolveThresholds,
  targetHistories,
} from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { targets as messages } from '@/i18n/messages/targets';
import { NotFoundError, msg } from '@/lib/errors';
import { apiRoute, readSearchParams } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

const querySchema = z.object({
  /** The window, in hours. Bounded by retention: asking for more would be lying. */
  hours: z.coerce
    .number()
    .int()
    .min(1)
    .max(HOST_SAMPLE_RETENTION_DAYS * 24)
    .default(24),
  /** Returned points. A 120-pixel curve does not need 2,000 values. */
  buckets: z.coerce.number().int().min(12).max(240).default(48),
});

/**
 * A machine's history — the memory the reading did not have.
 *
 * ── Why this route does **not** go through the queue ────────────────────────
 * `GET /api/targets/[id]/metrics` queues a job because the answer requires an SSH
 * session, and the panel never opens one. Here, there is no machine to reach:
 * the answer is in the database, written by the sweep. It is an SQL query, it is
 * done in the route like any read.
 *
 * A direct consequence, and it is the whole point: **this history answers even
 * when the machine is off.** The instant reading, for its part, returns
 * `reachable:false`. The screen therefore shows "unreachable" *and* the curve of
 * the last 24 h, which is exactly the moment one wants to see it.
 *
 * `target:read` is enough — the same permission as the instant reading, for the
 * same data, taken five minutes ago rather than right now.
 */
export const GET = apiRoute<Context>(async (request, context) => {
  await requirePermission(request, 'target:read');
  const { id } = paramsSchema.parse(await context.params);
  const query = readSearchParams(request, querySchema);

  const target = await getTarget(id);
  if (!target) throw new NotFoundError(msg(messages, 'error.notFound', { id }));

  const [histories, thresholds, breaches] = await Promise.all([
    targetHistories([id], query.hours, query.buckets),
    resolveThresholds(id),
    // Only the **ongoing** breaches: the screen's banner announces a present problem.
    // The timeline of closed episodes reads in the activity log, which is already the
    // screen made for that.
    listOpenBreaches([id]),
  ]);

  const history = histories.get(id);

  return NextResponse.json({
    targetId: id,
    targetName: target.name,
    // The cadence is returned with the window: "12 readings over 24 h" does not mean
    // the same thing depending on whether 288 or 12 were expected.
    intervalSeconds: HOST_SAMPLE_INTERVAL_SECONDS,
    retentionDays: HOST_SAMPLE_RETENTION_DAYS,
    ...history,
    thresholds,
    breaches,
  });
});
