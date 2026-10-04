import {
  deployChannel,
  deployMessageSchema,
  isTerminal,
  type DeployMessage,
  type DeploymentStatus,
} from '@pupitre/core';
import { getDeploymentSummary, readDeploymentLog } from '@pupitre/db';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { getEnv } from '@/lib/env';
import { deployments as messages } from '@/i18n/messages/deployments';
import { NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { logger } from '@/lib/logger';
import { requireApplicationScope, requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

const HEARTBEAT_MS = 15_000;

/**
 * A deployment's logs SSE stream.
 *
 * The order of operations is what guarantees there is no gap:
 *
 *   1. we subscribe to Redis **before** reading the history;
 *   2. the messages arriving during the read are set aside;
 *   3. we send the persisted history;
 *   4. we empty the waiting queue, then go live.
 *
 * Subscribing after the read would lose everything that happens in between.
 * Reading the history after emptying the queue would duplicate it.
 */
export const GET = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'deployment:read', { applicationScoped: true });
  const { id } = paramsSchema.parse(await context.params);

  const deployment = await getDeploymentSummary(id);
  if (!deployment) throw new NotFoundError(msg(messages, 'error.notFound', { id }));
  await requireApplicationScope(request, auth, deployment.applicationId);

  const channel = deployChannel(id);
  const encoder = new TextEncoder();
  // A dedicated connection: in `subscribe` mode, a Redis connection no longer
  // accepts other commands. It is closed when the client disconnects.
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
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          void cleanup();
        }
      };

      /** Prevents a duplicate between the history read back and a message received live. */
      const seen = new Set<string>();
      const fingerprint = (message: DeployMessage): string =>
        message.kind === 'log'
          ? `${message.payload.ts}|${message.payload.step}|${message.payload.line}`
          : `event|${message.payload.ts}|${message.payload.key}|${message.payload.status}`;

      const forward = (raw: string) => {
        const parsed = deployMessageSchema.safeParse(JSON.parse(raw) as unknown);
        if (!parsed.success) return;

        const key = fingerprint(parsed.data);
        if (seen.has(key)) return;
        seen.add(key);

        send(parsed.data.kind, parsed.data.payload);

        // The deployment is finished: we close cleanly rather than let the client wait
        // forever.
        if (
          parsed.data.kind === 'event' &&
          parsed.data.payload.type === 'deployment' &&
          isTerminal(parsed.data.payload.status as DeploymentStatus)
        ) {
          send('end', { status: parsed.data.payload.status });
          void cleanup().then(() => {
            try {
              controller.close();
            } catch {
              // Already closed on the client side.
            }
          });
        }
      };

      // 1. Abonnement d'abord.
      const pending: string[] = [];
      let live = false;
      subscriber.on('message', (_channel, raw: string) => {
        if (live) forward(raw);
        else pending.push(raw);
      });
      subscriber.on('error', (error) => {
        logger.warn({ err: error, channel }, 'connexion Redis du flux SSE en erreur');
      });

      try {
        await subscriber.subscribe(channel);
      } catch (error) {
        logger.error({ err: error, channel }, 'abonnement Redis impossible');
        send('error', { message: 'flux de logs indisponible' });
        await cleanup();
        controller.close();
        return;
      }

      // 2. Persisted history.
      send('status', {
        id: deployment.id,
        status: deployment.status,
        url: deployment.url,
        failedStep: deployment.failedStep,
      });

      const history = await readDeploymentLog(id);
      for (const entry of history) {
        for (const rawLine of entry.log.split('\n')) {
          if (rawLine.trim().length === 0) continue;
          try {
            const parsed = deployMessageSchema.safeParse({
              kind: 'log',
              payload: JSON.parse(rawLine) as unknown,
            });
            if (!parsed.success) continue;

            // The same deduplication as live: both paths must produce exactly the same
            // sequence of lines, otherwise a refresh would show something other than the
            // initial stream.
            const key = fingerprint(parsed.data);
            if (seen.has(key)) continue;
            seen.add(key);
            send('log', parsed.data.payload);
          } catch {
            // A line truncated by an abrupt stop: we skip it.
          }
        }
      }
      send('replayed', { lines: seen.size });

      // 3. We empty what arrived during the replay, then live.
      live = true;
      for (const raw of pending) forward(raw);
      pending.length = 0;

      // An already finished deployment will emit nothing more.
      if (isTerminal(deployment.status)) {
        send('end', { status: deployment.status });
        await cleanup();
        controller.close();
        return;
      }

      // 4. Heartbeat: a reverse proxy cuts a silent connection.
      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        } catch {
          void cleanup();
        }
      }, HEARTBEAT_MS);

      // The client disconnects: we release the Redis connection.
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
      // Disables nginx's buffering, which would hold the stream back.
      'x-accel-buffering': 'no',
    },
  });
});
