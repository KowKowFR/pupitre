import { workloadChannel, workloadMessageSchema } from '@pupitre/core';
import { getTarget } from '@pupitre/db';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { getEnv } from '@/lib/env';
import { targets as messages } from '@/i18n/messages/targets';
import { HttpError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { logger } from '@/lib/logger';
import { requirePermission } from '@/lib/rbac';
import { claimWorkloadRun } from '@/lib/workload-runs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

const HEARTBEAT_MS = 15_000;

/**
 * The progress of the actions on a target's workloads, over SSE.
 *
 * The same arrangement as the deployment logs, but without a history to read
 * again: a deletion or an update has no persisted past, so there is nothing to
 * replay before going live. The stream stays open from one action to the next —
 * it is a target channel, not a job one.
 */
export const GET = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'workload:read');
  const { id } = paramsSchema.parse(await context.params);

  // `?run=`: the stream of a single run (log, command), reserved to whoever opened
  // it. Without it, the target's stream — without the private outputs.
  const runParam = new URL(request.url).searchParams.get('run');
  const run = runParam ? z.string().uuid().parse(runParam) : null;
  if (run && !(await claimWorkloadRun(run, auth.userId))) {
    throw new HttpError(403, 'run_not_owned', msg(messages, 'error.runNotOwned'));
  }

  const target = await getTarget(id);
  if (!target) throw new NotFoundError(msg(messages, 'error.notFound', { id }));

  const channel = workloadChannel(id);
  const encoder = new TextEncoder();
  // A dedicated connection: once subscribed, a Redis connection accepts nothing
  // else.
  const subscriber = new Redis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });

  let heartbeat: NodeJS.Timeout | null = null;
  let closed = false;

  const cleanup = async () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    try {
      await subscriber.unsubscribe(channel);
    } catch {
      // The connection may already have dropped: nothing to save.
    }
    subscriber.disconnect();
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          void cleanup();
        }
      };

      subscriber.on('message', (_channel, raw: string) => {
        let payload: unknown;
        try {
          payload = JSON.parse(raw);
        } catch {
          return;
        }
        const parsed = workloadMessageSchema.safeParse(payload);
        if (!parsed.success) return;
        // A run's output only goes to that run's stream.
        const messageRun = parsed.data.payload.run ?? null;
        if (messageRun !== run) return;
        send(parsed.data.kind, parsed.data.payload);
      });

      subscriber.on('error', (error) => {
        logger.warn({ err: error, channel }, 'connexion Redis du flux SSE en erreur');
      });

      try {
        await subscriber.subscribe(channel);
      } catch (error) {
        logger.error({ err: error, channel }, 'abonnement Redis impossible');
        send('error', { message: 'flux indisponible' });
        await cleanup();
        controller.close();
        return;
      }

      send('ready', { targetId: id, channel });

      // Heartbeat: a reverse proxy cuts a silent connection.
      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        } catch {
          void cleanup();
        }
      }, HEARTBEAT_MS);

      request.signal.addEventListener('abort', () => {
        void cleanup().then(() => {
          try {
            controller.close();
          } catch {
            // Already closed.
          }
        });
      });
    },

    async cancel() {
      await cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
});
