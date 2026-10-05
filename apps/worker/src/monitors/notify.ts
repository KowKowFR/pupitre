import {
  buildMonitorAlert,
  languageOf,
  monitorTypeSchema,
  type MonitorStatus,
} from '@pupitre/core';
import { postWebhook } from '@pupitre/core/probe';
import {
  getAppSettingsValue,
  logAudit,
  markIncidentAlerted,
  monitorTarget,
  monitorWebhookUrl,
  type Monitor,
  type MonitorIncident,
} from '@pupitre/db';
import { instanceLanguage } from '../language.js';
import { logger } from '../logger.js';
import { allowedCidrs } from './policy.js';

/**
 * ⟵ **THE SEAM** ⟶
 *
 * Everything site monitoring sends to the outside goes through this single
 * function. The rest of the code — the sweep, the state machine — knows neither
 * webhook, nor `fetch`, nor payload format: it observes a transition and calls
 * `notifyMonitorTransition()`.
 *
 * ── Two outputs, on purpose ─────────────────────────────────────────────────
 * The announced seam was honored: the general notification channels (SMTP,
 * Telegram, Discord, webhook) are now served. But **not** by replacing this
 * function's body — by letting it do what it already did: write the audit.
 * `logAudit()` carries the observer that recognizes `monitor.down` /
 * `monitor.recovered` in the events catalog and queues the delivery. Zero calls
 * to the channels factory from here, zero imports of
 * `@pupitre/core/notifications` in monitoring: the connection fits in two table
 * entries, on the `packages/core/src/notifications/events.ts` side.
 *
 *   output 1 — the instance's channels, through the audit log. Burst grouping,
 *              named digests, per-channel retry: inherited, not rewritten.
 *   output 2 — **this probe's** webhook, below, unchanged.
 *
 * ── Why the per-probe webhook did not disappear ─────────────────────────────
 * It would have been easy to remove it "since the channels do better". They do
 * not do the same thing. A channel subscribes to an *event*, hence to **all**
 * the instance's probes; this webhook is attached to **one** probe. A host
 * monitoring thirty sites for twenty customers wants the customer's Slack
 * channel in its probe's webhook, and certainly not the twenty-nine others.
 * Removing it would force that case to receive all or nothing: a regression
 * without a replacement.
 *
 * Both can therefore fire for the same outage. It is not an accidental
 * duplicate: they are two distinct subscriptions, set by two distinct gestures,
 * and the probes screen says so in plain words when entering the URL. The
 * payload differs, by the way — here a raw `MonitorAlert`, cut for Slack and
 * Discord (`text` / `content`, metrics, incident identifier); there a neutral
 * message rendered by each channel in its own shape.
 *
 * Rules this seam holds:
 *
 *   1. We alert **at the transition**, never at each failure. Fifty messages for
 *      one outage, nobody reads them. It is the state machine that decides the
 *      transition; this function is only called when it happens. Both outputs
 *      inherit this hysteresis, since both go out from here.
 *   2. We alert **at recovery too**. An alert without its counterpart forces a
 *      manual check, which is exactly what we wanted to avoid.
 *   3. Sending **only once** is guaranteed upstream by the partial unique index
 *      on open incidents: no incident opened twice, hence no message twice.
 *   4. An unreachable webhook **does not fail the sweep**: the failure is
 *      recorded on the incident (`alert_error`) and audited. Losing the
 *      measurement because Slack was down would be the last straw. It does not
 *      fail output 1 either: the audit is written **before**, so the channels
 *      are already served when the webhook times out.
 *
 * The return value only concerns **output 2**: it feeds the sweep's `alerts`
 * counter, which counts probe webhook deliveries. Per-channel deliveries are
 * asynchronous — they live in the notifications queue and are counted there.
 */
export async function notifyMonitorTransition(
  monitor: Monitor,
  from: MonitorStatus,
  to: MonitorStatus,
  incident: MonitorIncident,
): Promise<boolean> {
  const event = to === 'healthy' ? 'monitor.up' : 'monitor.down';
  const kind = event === 'monitor.up' ? 'resolve' : 'open';

  /**
   * The alert's language is **the instance's**, as for the notification channels
   * (`handlers/notification.ts`): nobody is in front of a screen when a site goes
   * down, and the Slack channel receiving the sentence is the operator's. A
   * transition is rare — a few a day at worst —, so this read weighs on no hot
   * path.
   */
  const settings = await getAppSettingsValue();
  const language = languageOf(settings.locale);
  const target = monitorTarget(monitor, language);

  const alert = buildMonitorAlert(
    {
      event,
      monitor: {
        id: monitor.id,
        name: monitor.name,
        type: monitorTypeSchema.parse(monitor.type),
        target,
      },
      incident: {
        id: incident.id,
        startedAt: incident.startedAt,
        resolvedAt: incident.resolvedAt,
      },
      status: to,
      detail: monitor.lastDetail,
      metrics: monitor.lastMetrics ?? {},
      consecutiveFailures: incident.failureCount,
    },
    language,
  );

  /**
   * The state change is recorded **whatever happens** — even without a configured
   * webhook. The audit log is the operation's memory; it does not depend on a
   * receiver being present.
   *
   * And it is now much more than memory: `logAudit()` is the point where the
   * notifications observer recognizes `monitor.down` / `monitor.recovered` in the
   * catalog (`@pupitre/core` → `notifiableEventFor`) and queues the delivery to the
   * subscribed channels. In other words, **this payload is the message**. What is
   * not in it cannot be told to the operator — hence `startedAt` and
   * `durationSeconds`, without which a digest could not say "recovered after
   * 4 min" and would shrink to a counter.
   *
   * Nothing secret goes into it: the name, the public target, the verdict and the
   * measurements. The probe webhook's URL is never written here — any more than in
   * the logs.
   */
  const durationSeconds = incident.resolvedAt
    ? Math.max(
        0,
        Math.round((incident.resolvedAt.getTime() - incident.startedAt.getTime()) / 1000),
      )
    : null;

  await logAudit({
    action: event === 'monitor.up' ? 'monitor.recovered' : 'monitor.down',
    resourceType: 'monitor',
    resourceId: monitor.id,
    before: { status: from },
    after: {
      status: to,
      name: monitor.name,
      type: monitor.type,
      target,
      incidentId: incident.id,
      startedAt: incident.startedAt.toISOString(),
      resolvedAt: incident.resolvedAt?.toISOString() ?? null,
      durationSeconds,
      detail: monitor.lastDetail,
      metrics: monitor.lastMetrics ?? {},
      consecutiveFailures: incident.failureCount,
    },
  });

  let url: string | null;
  try {
    url = monitorWebhookUrl(monitor);
  } catch (error) {
    // A URL encrypted under another `MASTER_KEY`: we say so, we do not crash.
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ monitorId: monitor.id, err: error }, 'probe webhook unreadable');
    await markIncidentAlerted(incident.id, kind, { ok: false, error: message });
    return false;
  }

  if (!url) return false;

  const delivery = await postWebhook({
    url,
    payload: alert,
    allowlist: allowedCidrs(),
    language: await instanceLanguage(),
  });

  await markIncidentAlerted(
    incident.id,
    kind,
    delivery.ok ? { ok: true } : { ok: false, error: delivery.error },
  );

  if (!delivery.ok) {
    // Never the URL in the logs: it is the secret.
    logger.warn(
      { monitorId: monitor.id, incidentId: incident.id, error: delivery.error },
      'monitoring alert not delivered',
    );
    return false;
  }

  logger.info({ monitorId: monitor.id, incidentId: incident.id, event }, 'monitoring alert sent');
  return true;
}
