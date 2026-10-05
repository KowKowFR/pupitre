import {
  APP_LOGS_JOB,
  WATCH_REFRESH_MS,
  WATCH_TTL_SECONDS,
  appLogChannel,
  appLogMessageSchema,
  appLogWatchKey,
  appStatusKey,
  appStatusSchema,
  deploymentJobDataSchema,
  isSupervisable,
} from '@pupitre/core';
import { getDeploymentSummary } from '@pupitre/db';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { getT } from '@/i18n/server';
import { appConsole } from '@/i18n/messages/console';
import { deployments } from '@/i18n/messages/deployments';
import { getEnv } from '@/lib/env';
import { ConflictError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { logger } from '@/lib/logger';
import { requirePermission } from '@/lib/rbac';
import { getRedis } from '@/lib/redis';
import { getSupervisionQueue } from '@/lib/supervision-queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

const HEARTBEAT_MS = 15_000;

/**
 * Live application logs.
 *
 * Unlike deployment logs, these have no history to replay: what is past is past,
 * and `docker compose logs` gives back the last lines on opening. There is
 * therefore no seam to handle.
 *
 * On the other hand there is a remote SSH session to keep alive, and to cut when
 * nobody is watching any more. This route is the only place that knows a viewer
 * is present: it writes it into a short-lived Redis key, which it refreshes as
 * long as the connection holds. The worker reads it again and stops when it has
 * disappeared.
 */
export const GET = apiRoute<Context>(async (request, context) => {
  await requirePermission(request, 'deployment:read');
  const { id } = paramsSchema.parse(await context.params);

  const deployment = await getDeploymentSummary(id);
  // The stream's messages go out in the language of whoever opened it.
  const t = await getT(appConsole);
  if (!deployment) throw new NotFoundError(msg(deployments, 'error.notFound', { id }));
  if (!isSupervisable(deployment.status)) {
    throw new ConflictError(msg(appConsole, 'error.notFollowable', { status: deployment.status }));
  }

  const channel = appLogChannel(id);
  const watchKey = appLogWatchKey(id);
  const encoder = new TextEncoder();

  // A dedicated connection: in `subscribe` mode, a Redis connection no longer
  // accepts any other command. The panel's serves to write the presence key.
  const subscriber = new Redis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
  const control = getRedis();

  let heartbeat: NodeJS.Timeout | null = null;
  let presence: NodeJS.Timeout | null = null;
  let closed = false;

  const cleanup = async () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    if (presence) clearInterval(presence);
    try {
      await subscriber.unsubscribe(channel);
    } catch {
      // The connection may already have dropped.
    }
    subscriber.disconnect();
    // We do NOT delete the presence key: another tab may be watching the same
    // stream. It will expire on its own if nobody refreshes it any more.
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
        try {
          const parsed = appLogMessageSchema.safeParse(JSON.parse(raw) as unknown);
          if (parsed.success) send(parsed.data.kind, parsed.data.payload);
        } catch {
          // Unreadable message: we skip it rather than break the stream.
        }
      });
      subscriber.on('error', (error) => {
        logger.warn({ err: error, channel }, 'application stream Redis connection failed');
      });

      try {
        await subscriber.subscribe(channel);
      } catch (error) {
        logger.error({ err: error, channel }, 'application stream subscription failed');
        send('error', { message: t('stream.unavailable') });
        await cleanup();
        controller.close();
        return;
      }

      // Declare the presence BEFORE queuing the job: it refuses to open if it finds
      // nobody to serve.
      await control.set(watchKey, '1', 'EX', WATCH_TTL_SECONDS);

      /**
       * The last known state, served even before asking for a stream.
       *
       * The stream is **shared**: a single job per deployment, whatever the number of
       * viewers. Whoever arrives second — second tab, page reload, reconnection after a
       * cut — therefore joins a stream whose state snapshot went by long ago, and Redis
       * does not replay a `publish`. Without this replay, the screen showed very much
       * alive logs next to a "no container reported by the target": it contradicted
       * itself because the route had never given it anything.
       *
       * Read **before** queuing the job, so as not to risk covering with a kept state
       * the fresh reading this job publishes right away. The reading carries its
       * `checkedAt`: it is the screen that says its age. No SSH here — an HTTP route
       * does not go to the machine.
       */
      try {
        const retained = await control.get(appStatusKey(id));
        if (retained) {
          const parsed = appStatusSchema.safeParse(JSON.parse(retained) as unknown);
          if (parsed.success) send('status', parsed.data);
        }
      } catch (error) {
        // An unreadable kept state is not worth refusing the stream.
        logger.warn({ err: error, deploymentId: id }, 'last application state unreadable');
      }

      presence = setInterval(() => {
        control.set(watchKey, '1', 'EX', WATCH_TTL_SECONDS).catch((error: unknown) => {
          logger.warn({ err: error }, 'presence could not be refreshed');
        });
      }, WATCH_REFRESH_MS);

      /**
       * A fixed `jobId`: several viewers of the same deployment share a single stream,
       * and reopening a tab does not start a second SSH session. BullMQ forbids colons
       * in a job identifier — hence the dash rather than the channel's name.
       *
       * When a job with the same identifier already exists, BullMQ does not fail: it
       * returns the existing job without starting anything again. It is exactly the
       * behavior wanted for a second viewer — but only as long as the stream runs.
       * Hence `removeOnComplete`/`removeOnFail`: a finished stream must leave no trace,
       * otherwise its identifier would block any reopening until it expires. It is the
       * only job of the queue that gives up its history, and it is the price of a
       * fixed identifier.
       */
      try {
        await getSupervisionQueue().add(
          APP_LOGS_JOB,
          deploymentJobDataSchema.parse({ deploymentId: id, actorId: null, ip: null }),
          { jobId: `app-logs-${id}`, removeOnComplete: true, removeOnFail: true },
        );
      } catch (error) {
        // Silencing this error would leave the viewer in front of a mute stream.
        logger.error({ err: error, deploymentId: id }, 'stream could not be opened');
        send('error', { message: t('stream.openFailed') });
      }

      send('ready', { deploymentId: id, url: deployment.url, status: deployment.status });

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
