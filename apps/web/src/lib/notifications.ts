import 'server-only';
import {
  NOTIFICATIONS_QUEUE,
  NOTIFICATION_DISPATCH_JOB,
  NOTIFICATION_TEST_JOB,
  auditNotificationObserver,
  notificationTestJobDataSchema,
  notificationTestJobResultSchema,
  type NotificationTestJobResult,
} from '@pupitre/core';
import { setAuditObserver } from '@pupitre/db';
import { Queue, QueueEvents } from 'bullmq';
import { notifications } from '@/i18n/messages/notifications';
import { HttpError, msg } from './errors';
import { logger } from './logger';
import { getRedis } from './redis';

/**
 * The notifications plumbing, panel side.
 *
 * The panel **sends nothing itself**: `nodemailer` is deliberately kept out of
 * its dependency graph, exactly like `ssh2`. It queues, and the worker delivers.
 */

declare global {
  var __tpNotificationsQueue: Queue | undefined;
  var __tpNotificationsQueueEvents: QueueEvents | undefined;
}

export function getNotificationsQueue(): Queue {
  globalThis.__tpNotificationsQueue ??= new Queue(NOTIFICATIONS_QUEUE, {
    connection: getRedis(),
    defaultJobOptions: {
      // A single attempt: replaying a partially successful distribution would send the
      // message again to the channels that already received it.
      attempts: 1,
      removeOnComplete: { age: 24 * 3600, count: 500 },
      removeOnFail: { age: 7 * 24 * 3600 },
    },
  });
  return globalThis.__tpNotificationsQueue;
}

/**
 * Plugs the audit log into the notifications queue.
 *
 * Called once, from `instrumentation.ts`, before the server accepts the first
 * request. The worker does the same on its side: both processes write to
 * `audit_logs`, both must know how to queue. It is the panel that traces a role
 * change or a second factor reset; it is the worker that traces a failed
 * deployment.
 */
export function installAuditNotifications(): void {
  setAuditObserver(
    auditNotificationObserver(
      (data, dedup) =>
        getNotificationsQueue().add(NOTIFICATION_DISPATCH_JOB, data, {
          deduplication: { id: dedup.id, ttl: dedup.ttl },
        }),
      (error, event) => {
        // Without this line, an unavailable Redis would make the alerts disappear
        // without a word. The action, for its part, is never interrupted.
        logger.error({ err: error, event }, 'notification not queued');
      },
    ),
  );
}

/**
 * The bound of the test triggered from the screen.
 *
 * The channel itself gives itself 15 s (`NOTIFICATION_TIMEOUT_MS`), and a test
 * chains two — the probe then the sending. Thirty-five seconds therefore cover
 * the worst legitimate case plus waiting in the queue. Beyond that, it is no
 * longer the recipient that is slow, it is the worker that is not consuming, and
 * the caller deserves a plain 504 rather than a connection held open.
 */
const TEST_TIMEOUT_MS = 35_000;

/**
 * The queue's events stream, shared.
 *
 * Exported since the transactional account emails also wait for a verdict
 * (`@/lib/account-mail`): two `QueueEvents` instances on the same queue are two
 * Redis subscriptions to listen to the same thing.
 */
export function notificationsQueueEvents(): QueueEvents {
  return queueEvents();
}

function queueEvents(): QueueEvents {
  globalThis.__tpNotificationsQueueEvents ??= new QueueEvents(NOTIFICATIONS_QUEUE, {
    connection: getRedis(),
  });
  return globalThis.__tpNotificationsQueueEvents;
}

/**
 * A channel's test: the route **queues then waits**.
 *
 * The project's rule is that long-running *work* has no place in an HTTP route —
 * not that the route must give control back before knowing. It is the trade-off
 * already settled for a target's metrics reading (`/api/targets/[id]/metrics`),
 * and it holds here for the same reason, doubled with a constraint: the panel has
 * no SMTP transport. A "send a test message" button that answered "it is gone"
 * without saying whether it arrived would be useless — a wrong configuration would
 * only be discovered at the first incident, that is at the worst moment.
 */
export async function runChannelTest(
  channelId: string,
  actorId: string,
  ip: string | null,
): Promise<NotificationTestJobResult> {
  const data = notificationTestJobDataSchema.parse({ channelId, actorId, ip });

  // No custom job identifier: BullMQ refuses a "Custom Id" containing a `:`, and
  // this job's name contains one.
  const job = await getNotificationsQueue().add(NOTIFICATION_TEST_JOB, data, { attempts: 1 });

  let raw: unknown;
  try {
    raw = await job.waitUntilFinished(queueEvents(), TEST_TIMEOUT_MS);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // `waitUntilFinished` only tells the timeout from the job's failure by its
    // message — two situations, two codes.
    if (/timed out/i.test(message)) {
      throw new HttpError(
        504,
        'notification_test_timeout',
        msg(notifications, 'error.testTimeout'),
      );
    }
    throw new HttpError(
      502,
      'notification_test_failed',
      msg(notifications, 'error.testFailed', { detail: message }),
    );
  }

  const parsed = notificationTestJobResultSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(
      502,
      'notification_test_failed',
      msg(notifications, 'error.testUnreadable'),
    );
  }
  return parsed.data;
}
