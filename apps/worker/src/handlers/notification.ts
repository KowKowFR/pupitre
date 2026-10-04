import {
  NOTIFICATIONS_QUEUE,
  NOTIFICATION_DELIVER_ATTEMPTS,
  NOTIFICATION_DELIVER_BACKOFF_MS,
  NOTIFICATION_DELIVER_JOB,
  NOTIFICATION_DIGEST_SWEEP_EVERY_MS,
  NOTIFICATION_DIGEST_SWEEP_JOB,
  NOTIFICATION_DISPATCH_JOB,
  auditNotificationObserver,
  buildNotificationDigest,
  buildNotificationDigestItem,
  buildNotificationMessage,
  describeFailure,
  isNotificationEventKey,
  languageOf,
  maintenanceRuleOf,
  notificationDeliverJobDataSchema,
  notificationDigestGroupKey,
  notificationDigestPath,
  notificationDispatchJobDataSchema,
  notificationEventDescriptor,
  notificationEventLabel,
  notificationPayloadEvent,
  notificationTestJobDataSchema,
  testNotificationMessage,
  type NotificationDeliverJobResult,
  type NotificationDigestSweepJobResult,
  type NotificationDispatchJobData,
  type NotificationDispatchJobResult,
  type NotificationPayload,
  type NotificationRenderContext,
  type NotificationTestJobResult,
} from '@pupitre/core';
import { deliverNotification, getNotificationChannel } from '@pupitre/core/notifications';
import {
  admitNotification,
  claimNotificationDigest,
  dueNotificationDigestGroups,
  getAppSettingsValue,
  holdMaintenanceAlert,
  logAudit,
  notificationActorLabel,
  notificationChannelsForEvent,
  recordNotificationOutcome,
  resolveNotificationChannel,
  setAuditObserver,
  windowsCovering,
  type NotificationChannelRecord,
} from '@pupitre/db';
import { Queue, UnrecoverableError, type Job } from 'bullmq';
import { instanceLanguage } from '../language.js';
import { logger } from '../logger.js';
import { createRedisConnection } from '../redis.js';

/**
 * Sending notifications.
 *
 * ── Why the queue ───────────────────────────────────────────────────────────
 * An unreachable SMTP server takes about thirty seconds to time out, and an
 * on-call webhook can take as long. Rule 2 of the project: this work has no
 * business in an HTTP request's path — nor in `logAudit()`'s, which is called in
 * the middle of a user action. The audit log's observer therefore merely
 * queues.
 *
 * ── Three jobs, three responsibilities ──────────────────────────────────────
 *   `notification:dispatch`      decides: does this message go out now, or is
 *                                it held to be summarized?
 *   `notification:deliver`       delivers to **one** channel, and retries by itself
 *   `notification:digest_sweep`  closes the due windows and composes the digests
 *
 * The split between deciding and delivering is what makes retrying correct: the
 * first version's objection — "replaying a partially successful delivery would
 * send the message again to the channels that already received it" — no longer
 * holds once a job only concerns one recipient.
 *
 * ── The test, though, is awaited ────────────────────────────────────────────
 * The "send a test message" button wants a verdict, not an acknowledgment. The
 * pattern chosen is the one already settled for a target's metrics reading
 * (`/api/targets/[id]/metrics`): the route **queues then waits**, with a firm
 * bound. It runs nothing itself — it waits, as it waits for an SQL query. And it
 * cannot do otherwise: the Next panel has no SMTP transport, `nodemailer` being
 * deliberately kept out of its graph, exactly like `ssh2`.
 */

// ─── producer ─────────────────────────────────────────────────────────────────

let notificationsQueue: Queue | null = null;

/**
 * Notifications queue, producer side. The worker is its own producer here: it
 * is the one recording failed deployments, hence the one queuing the matching
 * deliveries.
 */
function getNotificationsQueue(): Queue {
  notificationsQueue ??= new Queue(NOTIFICATIONS_QUEUE, {
    connection: createRedisConnection(),
    defaultJobOptions: {
      /**
       * **A single attempt by default.** It holds for the decision (`dispatch`) and for
       * the sweep: replaying them would repair nothing and could duplicate a digest.
       * The *delivery* jobs explicitly ask for their three attempts — see
       * `enqueueDeliveries()`.
       */
      attempts: 1,
      removeOnComplete: { age: 24 * 3600, count: 500 },
      removeOnFail: { age: 7 * 24 * 3600 },
    },
  });
  return notificationsQueue;
}

export async function closeNotificationsQueue(): Promise<void> {
  if (notificationsQueue) {
    await notificationsQueue.close();
    notificationsQueue = null;
  }
}

/**
 * Plugs the audit log into the notifications queue.
 *
 * To call once at process startup. The panel does the same on its side, from its
 * `instrumentation.ts`: both write into `audit_logs`, so both must know how to
 * queue.
 */
export function installAuditNotifications(): void {
  setAuditObserver(
    auditNotificationObserver(
      (data, dedup) =>
        getNotificationsQueue().add(NOTIFICATION_DISPATCH_JOB, data, {
          deduplication: { id: dedup.id, ttl: dedup.ttl },
        }),
      (error, event) => {
        // The queuing failure is reported nowhere else: without this line, an
        // unavailable Redis would make alerts disappear without a word.
        logger.error({ err: error, event }, 'notification not queued');
      },
    ),
  );
}

/**
 * Puts back into delivery an alert a maintenance window had held, as it went
 * out the first time. It goes through the decision again: if another window
 * still covers its subject, that one keeps it.
 */
export async function releaseHeldNotification(
  data: NotificationDispatchJobData,
  dedupId: string,
): Promise<void> {
  await getNotificationsQueue().add(NOTIFICATION_DISPATCH_JOB, data, {
    deduplication: { id: dedupId },
  });
}

/**
 * Installs the clock that closes the grouping windows.
 *
 * No database row for this scheduler, hence no reconciliation: it is a run
 * detail, reinstalled identically at each startup. What lives in the database is
 * the windows' state — and that is precisely what makes a worker restarted in
 * the middle of a storm find its windows open instead of releasing everything at
 * once. The same construction as the probes sweep.
 */
export async function installNotificationDigestSweep(): Promise<void> {
  await getNotificationsQueue().upsertJobScheduler(
    'notification-digest-sweep',
    { every: NOTIFICATION_DIGEST_SWEEP_EVERY_MS },
    {
      name: NOTIFICATION_DIGEST_SWEEP_JOB,
      data: {},
      opts: {
        attempts: 1,
        // The interval is a few seconds: keeping a thousand occurrences would teach
        // nothing and clutter Redis.
        removeOnComplete: { age: 600, count: 50 },
        removeOnFail: { age: 24 * 3600, count: 50 },
      },
    },
  );
  logger.info({ everyMs: NOTIFICATION_DIGEST_SWEEP_EVERY_MS }, 'digest windows sweep installed');
}

// ─── distribution ─────────────────────────────────────────────────────────────

/**
 * The panel's public root, for the messages' links.
 *
 * Read directly from the environment rather than added to the worker's schema:
 * it is not a dependency of its working — a message without a link stays a
 * useful message —, and the worker must not refuse to start because a
 * convenience URL is missing. The shared `.env` already carries it for the panel
 * (`BETTER_AUTH_URL`).
 */
function panelUrl(): string | null {
  const raw = process.env.BETTER_AUTH_URL?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/**
 * Queues one delivery per subscribed channel.
 *
 * `addBulk` and not a loop of `add`: it is one Redis round trip instead of four,
 * on a path that must stay short — it is what separates the incident from the
 * first alert.
 *
 * The payload travels **composed**. Composing again in the delivery would make
 * a retry three minutes later produce a message different from the one the
 * other channels received; and it would make each attempt depend on the
 * database. No secret goes through it: the neutral message contains none, the
 * channel's configuration is read again at send time.
 */
async function enqueueDeliveries(
  channels: NotificationChannelRecord[],
  payload: NotificationPayload,
): Promise<number> {
  if (channels.length === 0) return 0;

  await getNotificationsQueue().addBulk(
    channels.map((channel) => ({
      name: NOTIFICATION_DELIVER_JOB,
      data: { channelId: channel.id, channelName: channel.name, payload },
      opts: {
        attempts: NOTIFICATION_DELIVER_ATTEMPTS,
        backoff: { type: 'exponential', delay: NOTIFICATION_DELIVER_BACKOFF_MS },
        removeOnComplete: { age: 24 * 3600, count: 500 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    })),
  );

  return channels.length;
}

/**
 * Decides the fate of a notifiable event.
 *
 * The "immediate" path is the default path and it is **short**: read the
 * subscribed channels, compose, decide, queue. No wait, no deliberate delay. A
 * digest that delayed the first alert would have traded one flaw for a worse
 * one.
 */
export async function handleNotificationDispatch(
  job: Job<unknown, NotificationDispatchJobResult>,
): Promise<NotificationDispatchJobResult> {
  const data = notificationDispatchJobDataSchema.parse(job.data);
  const log = logger.child({ jobId: job.id, event: data.event });

  const nothing = (mode: 'skipped') => ({
    event: data.event,
    targeted: 0,
    delivered: 0,
    failed: 0,
    mode,
    queued: 0,
  });

  if (!isNotificationEventKey(data.event)) {
    // An event removed from the catalog between queuing and consumption.
    log.warn('unknown event, delivery abandoned');
    return nothing('skipped');
  }

  const channels = await notificationChannelsForEvent(data.event);
  if (channels.length === 0) {
    // Nobody listens: we do not touch the grouping state either. Opening a window
    // for an event nobody receives would hold the first alert of the day someone
    // subscribes.
    log.debug('no subscribed channel');
    return nothing('skipped');
  }

  const [settings, actor] = await Promise.all([
    getAppSettingsValue(),
    notificationActorLabel(data.entry.actorId),
  ]);

  const ctx: NotificationRenderContext = {
    instance: settings.instanceName,
    panelUrl: panelUrl(),
    actor,
    occurredAt: data.occurredAt,
    // Nobody is in front of the screen: the alert's language is the instance's, the
    // same as the panel and the invitation emails.
    language: languageOf(settings.locale),
  };

  const message = buildNotificationMessage(data.event, data.entry, ctx);
  const item = buildNotificationDigestItem(data.event, data.entry, ctx);

  // A maintenance window comes before grouping: an alert it holds does not have to
  // open a digest window. It is not lost — the end of the window puts it back
  // into delivery if its problem is still there.
  const rule = maintenanceRuleOf(data.event);
  const subject = rule?.subject(data.entry) ?? null;
  if (rule && subject) {
    const [window] = await windowsCovering(subject);
    if (window) {
      await holdMaintenanceAlert({
        windowId: window.id,
        event: data.event,
        family: rule.family(data.entry),
        opens: rule.opens,
        label: message.title,
        subject,
        data: data as unknown as Record<string, unknown>,
      });
      log.info({ windowId: window.id, label: message.title }, 'alert held by a maintenance window');
      return {
        event: data.event,
        targeted: channels.length,
        delivered: 0,
        failed: 0,
        mode: 'silenced',
        queued: 0,
      };
    }
  }

  const admission = await admitNotification({
    groupKey: notificationDigestGroupKey(data.event),
    event: data.event,
    item,
  });

  if (admission.mode === 'held') {
    log.info(
      {
        heldCount: admission.heldCount,
        windowEndsAt: admission.windowEndsAt.toISOString(),
        label: item.label,
      },
      'alert held for a digest',
    );
    return {
      event: data.event,
      targeted: channels.length,
      delivered: 0,
      failed: 0,
      mode: 'held',
      queued: 0,
    };
  }

  const queued = await enqueueDeliveries(channels, { type: 'event', message });
  log.info({ targeted: channels.length, queued }, 'alert queued without delay');

  return {
    event: data.event,
    targeted: channels.length,
    delivered: 0,
    failed: 0,
    mode: 'immediate',
    queued,
  };
}

/**
 * Closes the due windows and composes the digests.
 *
 * The sweep is **stateless**: it reads the database again, assumes nothing about
 * what happened before, and can therefore be interrupted, restarted or run by
 * another worker without consequence. `claimNotificationDigest()`'s transaction
 * guarantees a group is only summarized once even if two sweeps cross.
 */
export async function handleNotificationDigestSweep(
  job: Job<unknown, NotificationDigestSweepJobResult>,
): Promise<NotificationDigestSweepJobResult> {
  const groups = await dueNotificationDigestGroups();
  if (groups.length === 0) return { examined: 0, digests: 0, queued: 0 };

  const log = logger.child({ jobId: job.id });
  let digests = 0;
  let queued = 0;

  for (const groupKey of groups) {
    const claim = await claimNotificationDigest(groupKey);
    // `null`: the window closed without having held anything. The group becomes
    // quiet again, the next isolated outage will go out without delay.
    if (!claim) continue;

    if (!isNotificationEventKey(claim.event)) {
      log.warn({ groupKey, event: claim.event }, 'digest abandoned: event outside the catalog');
      continue;
    }

    const channels = await notificationChannelsForEvent(claim.event);
    if (channels.length === 0) {
      // Every subscription was removed during the window. We say so: held alerts
      // disappear here, and silence would be misleading.
      log.warn(
        { groupKey, count: claim.count },
        'digest without recipient: no subscribed channel left',
      );
      continue;
    }

    const settings = await getAppSettingsValue();
    const descriptor = notificationEventDescriptor(claim.event);
    const language = languageOf(settings.locale);

    const digest = buildNotificationDigest({
      event: claim.event,
      severity: descriptor.severity,
      eventLabel: notificationEventLabel(claim.event, language),
      items: claim.items,
      count: claim.count,
      windowStartedAt: claim.windowStartedAt.toISOString(),
      windowEndedAt: claim.windowEndedAt.toISOString(),
      windowMs: claim.windowMs,
      nextWindowMs: claim.nextWindowMs,
      instance: settings.instanceName,
      panelUrl: panelUrl(),
      path: notificationDigestPath(claim.event),
      language,
    });

    digests += 1;
    queued += await enqueueDeliveries(channels, { type: 'digest', digest });

    log.info(
      { groupKey, count: claim.count, named: claim.items.length, nextWindowMs: claim.nextWindowMs },
      'digest composed',
    );
  }

  return { examined: groups.length, digests, queued };
}

/**
 * Delivers to **one** channel.
 *
 * Three attempts, a single recipient: retrying can therefore send nothing again
 * to someone who had already received it. Delivery is *at least once* — a
 * successful send whose acknowledgment gets lost will go out twice. It is the
 * accepted trade-off: a duplicate message is a nuisance, an incident message
 * that never went out is an outage.
 *
 * The outcome is recorded only **once**, at the end: on a success, or on the last
 * failed attempt. Counting each attempt would inflate `consecutive_failures`,
 * which answers "since when has this channel not worked?" and not "how many
 * packets were lost?".
 */
export async function handleNotificationDeliver(
  job: Job<unknown, NotificationDeliverJobResult>,
): Promise<NotificationDeliverJobResult> {
  const data = notificationDeliverJobDataSchema.parse(job.data);
  const event = notificationPayloadEvent(data.payload);
  const attempt = (job.attemptsMade ?? 0) + 1;
  const maxAttempts = job.opts.attempts ?? 1;
  const log = logger.child({ jobId: job.id, event, channel: data.channelName, attempt });

  const resolved = await resolveNotificationChannel(data.channelId);
  if (!resolved) {
    // Channel deleted between the decision and the delivery. Nothing to repair:
    // retrying would not make it reappear.
    log.warn('channel gone, delivery abandoned');
    throw new UnrecoverableError(`channel "${data.channelName}" not found`);
  }

  try {
    await deliverNotification(
      getNotificationChannel(resolved.row.kind),
      resolved.resolved,
      data.payload,
    );
  } catch (error) {
    // `describeFailure` scrubs: a provider's message can contain a token fragment,
    // and it would otherwise end up in the database and in the audit log.
    const detail = describeFailure(error, resolved.resolved.secrets, await instanceLanguage());

    if (attempt < maxAttempts) {
      log.warn({ error: detail }, 'delivery failed, retry scheduled');
      throw error;
    }

    await recordNotificationOutcome(data.channelId, { ok: false, error: detail });
    log.error({ error: detail }, 'notification not delivered');

    /**
     * The failure is recorded. `notification.delivery.failed` is deliberately **not**
     * a notifiable event: trying to warn that we could not warn would make the
     * delivery loop on itself.
     */
    await logAudit({
      actorId: null,
      action: 'notification.delivery.failed',
      resourceType: 'notification_channel',
      resourceId: data.channelId,
      after: {
        event,
        channel: data.channelName,
        error: detail,
        attempts: attempt,
        digest: data.payload.type === 'digest',
      },
    });

    throw new Error(detail);
  }

  await recordNotificationOutcome(data.channelId, { ok: true });
  log.info({ digest: data.payload.type === 'digest' }, 'notification delivered');

  return { channelId: data.channelId, event, delivered: true, attempt, error: null };
}

// ─── manual test ──────────────────────────────────────────────────────────────

export async function handleNotificationTest(
  job: Job<unknown, NotificationTestJobResult>,
): Promise<NotificationTestJobResult> {
  const data = notificationTestJobDataSchema.parse(job.data);
  const resolved = await resolveNotificationChannel(data.channelId);
  if (!resolved) throw new Error(`Channel "${data.channelId}" not found`);

  const { row } = resolved;
  const settings = await getAppSettingsValue();
  const language = languageOf(settings.locale);
  const implementation = getNotificationChannel(row.kind);

  // Two distinct steps, reported separately: the probe says whether the
  // credentials are right, the send says whether the recipient is the right one.
  // A valid Telegram token pointed at a nonexistent chat passes the first and
  // fails the second — and that is exactly what the operator must see.
  const probe = await implementation.test(resolved.resolved, language);

  let delivered = false;
  let error: string | null = null;
  try {
    await implementation.send(
      resolved.resolved,
      testNotificationMessage({
        instance: settings.instanceName,
        panelUrl: panelUrl(),
        channelName: row.name,
        language,
      }),
    );
    delivered = true;
  } catch (sendError) {
    error = describeFailure(sendError, resolved.resolved.secrets, language);
  }

  await recordNotificationOutcome(row.id, { ok: delivered, error });

  logger.info(
    { channelId: row.id, kind: row.kind, probeOk: probe.ok, delivered },
    'notification channel test',
  );

  return { channelId: row.id, kind: row.kind, probe, delivered, error };
}
