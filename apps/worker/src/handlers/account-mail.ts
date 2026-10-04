import {
  accountMailJobDataSchema,
  accountMailSchema,
  decrypt,
  describeFailure,
  languageOf,
  renderAccountMail,
  type AccountMailJobResult,
} from '@pupitre/core';
import {
  NOTIFICATION_TIMEOUT_MS,
  nodemailerTransport,
  smtpOptionsFrom,
  smtpSenderFrom,
} from '@pupitre/core/notifications';
import {
  getAppSettingsValue,
  listNotificationChannels,
  logAudit,
  resolveNotificationChannel,
  type NotificationChannelRecord,
} from '@pupitre/db';
import { UnrecoverableError, type Job } from 'bullmq';
import { instanceLanguage } from '../language.js';
import { logger } from '../logger.js';
import { workerSay } from '../messages.js';

/**
 * The accounts' life-cycle transactional emails: invitation and password reset.
 *
 * ── Why here and not in the panel ───────────────────────────────────────────
 * The panel has no SMTP transport — `nodemailer` is kept out of its graph
 * exactly like `ssh2`, and `verify-server-supervision.sh` goes as far as looking
 * for `ssh2` in its bundle to prove it. It queues, the worker delivers. It is the
 * same path as a channel's test.
 *
 * ── Why it is not a notification ────────────────────────────────────────────
 * A notification goes to a channel's **configured** recipients; this email goes
 * to the person designated by the action. We therefore borrow the SMTP
 * channel's transport (server, port, encryption, credentials, sender) and
 * nothing else — not its "Recipients" field, not its event subscriptions, not
 * its alert formatting.
 */

/**
 * The SMTP channel whose transport is borrowed.
 *
 * Rule: the first **active** SMTP channel in the alphabetical order of its name
 * — that is the order in which the settings screen shows them, hence a choice
 * an operator can predict without reading this file. An instance that
 * configures two has already decided both can post; one that configures none
 * cannot invite, and the screen says so before offering the journey.
 *
 * Deliberately not a "transactional channel" flag in the database: it would be
 * a column, a migration, one more checkbox on a screen, and a fourth way to get
 * it wrong — for a trade-off 99% of instances will never meet.
 */
function pickTransactionalMailChannel(
  channels: NotificationChannelRecord[],
): NotificationChannelRecord | null {
  return (
    channels.find(
      (channel) =>
        channel.kind === 'smtp' &&
        channel.enabled &&
        typeof channel.config.host === 'string' &&
        channel.config.host.trim().length > 0,
    ) ?? null
  );
}

export async function handleAccountMail(
  job: Job<unknown, AccountMailJobResult>,
): Promise<AccountMailJobResult> {
  const data = accountMailJobDataSchema.parse(job.data);
  const log = logger.child({ jobId: job.id, kind: data.kind, userId: data.userId });

  const channels = await listNotificationChannels();
  const picked = pickTransactionalMailChannel(channels);

  if (!picked) {
    /**
     * No SMTP channel: the message will not go out, and nothing will make it go out
     * later. `UnrecoverableError` rather than an ordinary failure — a retry would not
     * configure an email server.
     *
     * The panel already refuses to open the journey in that case; we get here when
     * the channel was deleted between the form and the consumption.
     */
    await logAudit({
      actorId: null,
      action: 'account.mail.undeliverable',
      resourceType: 'user',
      resourceId: data.userId,
      after: { kind: data.kind, reason: 'no_smtp_channel' },
    });
    log.error('no active SMTP channel: account email cannot be delivered');
    throw new UnrecoverableError(workerSay(await instanceLanguage())('mail.noSmtp'));
  }

  const resolved = await resolveNotificationChannel(picked.id);
  if (!resolved) throw new UnrecoverableError(`channel "${picked.name}" gone`);

  const settings = await getAppSettingsValue();

  /**
   * The link only exists in clear here, in the worker's memory, while rendering.
   * It goes down neither to the database, nor the audit log, nor the logs — the
   * `log.child` above only carries the account's type and identifier.
   */
  const mail = accountMailSchema.parse({
    kind: data.kind,
    to: data.to,
    recipientName: data.recipientName,
    instance: settings.instanceName,
    url: decrypt(data.encryptedUrl),
    expiresAt: data.expiresAt,
    actor: data.actor,
  });

  /**
   * The email's language is **the instance's**, not the recipient's: an
   * invitation goes to someone who has no account yet, so nobody to ask. The same
   * rule as alerts and the panel, and the same source — the regional locale.
   */
  const envelope = renderAccountMail(mail, languageOf(settings.locale));
  const transport = nodemailerTransport(smtpOptionsFrom(resolved.resolved, NOTIFICATION_TIMEOUT_MS));

  try {
    await transport.send({
      from: smtpSenderFrom(resolved.resolved),
      // A single recipient, always: the account's. The channel's "Recipients" field
      // only applies to its alerts.
      to: [mail.to],
      subject: envelope.subject,
      text: envelope.text,
      html: envelope.html,
      inlineImages: envelope.inlineImages,
      headers: {
        // The type, not the content: it allows a filter on the email client side and
        // says nothing that is not already in the subject.
        'X-Control-Plane-Account-Mail': mail.kind,
        // RFC 3834: this message must trigger neither an automatic reply nor an
        // out-of-office message — the person has nobody to reply to here.
        'Auto-Submitted': 'auto-generated',
      },
    });
  } catch (error) {
    const detail = describeFailure(error, resolved.resolved.secrets, await instanceLanguage());
    await logAudit({
      actorId: null,
      action: 'account.mail.failed',
      resourceType: 'user',
      resourceId: data.userId,
      after: { kind: data.kind, channel: picked.name, error: detail },
    });
    log.error({ error: detail }, 'account email not delivered');
    return { kind: data.kind, delivered: false, channel: picked.name, error: detail };
  } finally {
    transport.close();
  }

  /**
   * No call to `recordNotificationOutcome()`.
   *
   * These counters answer "since when has this channel stopped alerting?". A
   * recipient refusal (550 on a wrong address) teaches nothing about that and
   * would show in red, on the settings screen, a channel whose alerts work
   * perfectly.
   */
  await logAudit({
    actorId: null,
    action: 'account.mail.sent',
    resourceType: 'user',
    resourceId: data.userId,
    // No token, no link: only the address, which is already in `users.email`, and
    // the deadline, which opens nothing.
    after: { kind: data.kind, to: mail.to, channel: picked.name, expiresAt: mail.expiresAt },
  });

  log.info({ channel: picked.name }, 'account email delivered');
  return { kind: data.kind, delivered: true, channel: picked.name, error: null };
}
