import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  ACCOUNT_MAIL_ATTEMPTS,
  ACCOUNT_MAIL_JOB,
  accountMailJobDataSchema,
  accountMailJobResultSchema,
  encrypt,
  type AccountMailJobResult,
  type AccountMailKind,
} from '@pupitre/core';
import { listNotificationChannels } from '@pupitre/db';
import type { Job } from 'bullmq';
import { account as messages } from '@/i18n/messages/account';
import { HttpError, msg } from './errors';
import { logger } from './logger';
import { getNotificationsQueue, notificationsQueueEvents } from './notifications';

/**
 * The accounts' life-cycle emails, panel side: **we queue, we do not send**.
 *
 * The panel has no SMTP transport — `nodemailer` is kept out of its graph like
 * `ssh2`. The real work belongs to the worker
 * (`apps/worker/src/handlers/account-mail.ts`).
 */

/**
 * An invitation link's lifetime: 72 hours.
 *
 * The choice is between two failures. Too short, the invitation sent on a Friday
 * evening is dead on Monday morning, and the administrator spends their time
 * resending them. Too long, a link that opens an account sleeps for months in an
 * inbox — and an inbox is not a safe.
 *
 * 72 hours cover a complete weekend, and no more. Resending an expired invitation
 * is a button on `/admin/users`; it is not a reason to lengthen everyone's link.
 *
 * It is not a reset's duration: that one is one hour, because the person asking
 * for it is in front of their screen when they ask. See
 * `PASSWORD_RESET_TTL_SECONDS` in `./auth.ts`.
 */
export const INVITATION_TTL_MS = 72 * 3600 * 1000;

/**
 * The waiting bound of a sending whose verdict we want.
 *
 * The same reasoning — and the same value — as a channel's test: the channel
 * gives itself 15 s, the queue can add as much, and beyond that it is no longer
 * the SMTP server that is slow but the worker that is not consuming.
 */
const DELIVERY_TIMEOUT_MS = 35_000;

/**
 * Can the instance post an email?
 *
 * The question is asked of `notification_channels`: that is where the SMTP
 * configuration lives, typed once on `/admin/settings/notifications`, with its
 * encrypted password. Giving it a second one, specific to the accounts' life
 * cycle, would require typing the same server twice and discovering one day that
 * one of the two stopped working.
 *
 * Only the public part is read here: `listNotificationChannels()` never returns
 * the secrets. The project's only decryption stays
 * `resolveNotificationChannel()`, called by the worker at sending time.
 */
export async function mailChannelName(): Promise<string | null> {
  try {
    const channels = await listNotificationChannels();
    const smtp = channels.find(
      (channel) =>
        channel.kind === 'smtp' &&
        channel.enabled &&
        typeof channel.config.host === 'string' &&
        channel.config.host.trim().length > 0,
    );
    return smtp?.name ?? null;
  } catch (error) {
    // An unreachable database must not bring a sign-in screen down. We answer "no
    // channel": the worst that happens is that a "forgot password" link is wrongly
    // hidden, which is exactly the behavior wanted when we do not know.
    logger.error({ err: error }, 'notification channels could not be read');
    return null;
  }
}

/** `true` if an account email has a chance of going out. */
export async function canSendAccountMail(): Promise<boolean> {
  return (await mailChannelName()) !== null;
}

export type AccountMailRequest = {
  kind: AccountMailKind;
  userId: string;
  to: string;
  recipientName: string;
  /** The link carrying the token. Encrypted before entering the queue. */
  url: string;
  expiresAt: Date;
  /** Who triggered the sending, when someone triggered it. */
  actor?: string | null;
};

function toJobData(request: AccountMailRequest) {
  return accountMailJobDataSchema.parse({
    kind: request.kind,
    userId: request.userId,
    to: request.to,
    recipientName: request.recipientName,
    // The token only crosses Redis encrypted. See the schema's comment in
    // `@pupitre/core/queue` for the complete reasoning.
    encryptedUrl: encrypt(request.url),
    expiresAt: request.expiresAt.toISOString(),
    actor: request.actor ?? null,
  });
}

/**
 * Deliberately short retention.
 *
 * The payload is encrypted, but a finished job teaches nobody anything any more:
 * the verdict is already in `audit_logs` (`account.mail.sent` /
 * `account.mail.failed`). Sixty seconds only leave the caller the time to read
 * the result.
 */
const JOB_OPTIONS = {
  attempts: ACCOUNT_MAIL_ATTEMPTS,
  removeOnComplete: { age: 60, count: 20 },
  removeOnFail: { age: 3600, count: 50 },
} as const;

/**
 * ## The problem this small piece of asynchronous context solves
 *
 * It is Better Auth that makes the token, and it only gives it in one place: its
 * `sendResetPassword` callback. This callback does not know *who* triggered it —
 * the public "forgot password" form, or an administrator inviting. Yet the two
 * do not have the same need:
 *
 *   — the public reset **must not wait** for the sending. Otherwise the "this
 *     account exists" path would last a few seconds more than the "this address
 *     is unknown" path, and anyone could time the difference. Better Auth's
 *     anti-enumeration would be cancelled by our own code;
 *   — the invitation **must** wait: an administrator is looking at their screen,
 *     and "it is queued" teaches them nothing about what really went out.
 *
 * `AsyncLocalStorage` carries this difference without a global variable nor a
 * parameter to pass through Better Auth: the caller that wants the verdict opens
 * a context, the sending that happens in it drops its job there, and the caller
 * waits for it. Outside a context — the default case —, the sending goes out in
 * the background.
 *
 * This rests on a fact checked in the installed version: Better Auth **awaits**
 * `sendResetPassword` (`runInBackgroundOrAwait` only switches to the background
 * if `advanced.backgroundTasks.handler` is configured, which we do not do). If
 * that changed, `captureAccountMail()` would return a `null` verdict —
 * degradation, not an outage: see its comment.
 */
type MailScope = { pending: Promise<Job> | null };

const mailScope = new AsyncLocalStorage<MailScope>();

/**
 * Queues. Waits if — and only if — the caller opened a capture context; goes out
 * in the background otherwise.
 */
export function sendAccountMail(request: AccountMailRequest): void {
  const pending = getNotificationsQueue().add(ACCOUNT_MAIL_JOB, toJobData(request), JOB_OPTIONS);

  const scope = mailScope.getStore();
  if (scope) {
    scope.pending = pending;
    // An unhandled rejection would kill the process if the caller gives up before
    // waiting. The `catch` here masks nothing: `captureAccountMail()` reads the same
    // promise again and will handle it.
    pending.catch(() => undefined);
    return;
  }

  void pending.catch((error: unknown) => {
    // Without this line, an unavailable Redis would make the resets disappear
    // without a word, and nobody would understand why "the mail never arrives".
    logger.error({ err: error, kind: request.kind }, 'account email not queued');
  });
}

/**
 * Runs `fn` and returns, on top of its result, the verdict of the email it
 * triggered.
 *
 * `verdict: null` means "no email went out during this call" — for instance
 * because Better Auth found no account. The caller decides what that means on
 * its side; here we do not guess.
 */
export async function captureAccountMail<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; verdict: AccountMailJobResult | null }> {
  const scope: MailScope = { pending: null };
  const value = await mailScope.run(scope, fn);

  if (!scope.pending) return { value, verdict: null };

  const job = await scope.pending;

  let raw: unknown;
  try {
    raw = await job.waitUntilFinished(notificationsQueueEvents(), DELIVERY_TIMEOUT_MS);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/timed out/i.test(message)) {
      throw new HttpError(504, 'account_mail_timeout', msg(messages, 'mail.timeout'));
    }
    // The worker reported a failure (SMTP server unreachable, address refused…). The
    // message is already redacted of any secret by `describeFailure()` on the worker
    // side.
    throw new HttpError(502, 'account_mail_failed', msg(messages, 'mail.failed', { message }));
  }

  const parsed = accountMailJobResultSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(502, 'account_mail_failed', msg(messages, 'mail.unreadableVerdict'));
  }
  return { value, verdict: parsed.data };
}
