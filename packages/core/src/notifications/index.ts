import { type NotificationChannelKind } from './catalog.js';
import { DiscordChannel } from './discord.js';
import { SmtpChannel, nodemailerTransport } from './smtp.js';
import { TelegramChannel } from './telegram.js';
import type { NotificationChannel, NotificationTransports } from './types.js';
import { WebhookChannel } from './webhook.js';

export * from './catalog.js';
export * from './digest.js';
export * from './dispatch.js';
export * from './events.js';
export * from './message.js';
export * from './types.js';
export { escapeMarkdownV2, TelegramChannel } from './telegram.js';
export { DiscordChannel } from './discord.js';
export { WebhookChannel } from './webhook.js';
export { BRAND_MARK, EMAIL_COLORS, type InlineImage } from './brand.js';
export { SmtpChannel, nodemailerTransport, smtpOptionsFrom, smtpSenderFrom } from './smtp.js';

/**
 * Notification channel factory.
 *
 * The same shape as `getDriver()`, `getScanner()` and `getAiProviderFactory()`:
 * a registry indexed by key, one implementation per channel, and **no**
 * `if (kind === …)` elsewhere in the project. The `Record<…>` type is the
 * guarantee that a channel declared in the catalog without a factory does not
 * compile.
 *
 * Transports are passed at construction rather than imported by the
 * implementations. That is what lets a test provide a fake `fetch` and a fake
 * SMTP transport, hence exercise each payload's exact shape without network,
 * without a mail server and without a token.
 */
const registry: Record<
  NotificationChannelKind,
  (transports: NotificationTransports) => NotificationChannel
> = {
  smtp: (t) => new SmtpChannel(t.smtp, t.timeoutMs),
  telegram: (t) => new TelegramChannel(t.fetch, t.timeoutMs),
  discord: (t) => new DiscordChannel(t.fetch, t.timeoutMs),
  webhook: (t) => new WebhookChannel(t.fetch, t.timeoutMs),
};

/**
 * Bound of an outgoing call.
 *
 * Fifteen seconds: a slow SMTP server takes ten to twenty seconds to accept a
 * session, and the test triggered from the screen waits for the answer (see the
 * `/api/notifications/channels/[id]/test` route). Shorter would cut legitimate
 * servers; longer would keep the HTTP request open beyond what an operator
 * accepts to watch.
 */
export const NOTIFICATION_TIMEOUT_MS = 15_000;

export function defaultNotificationTransports(): NotificationTransports {
  return {
    fetch: (input, init) => fetch(input, init),
    smtp: nodemailerTransport,
    timeoutMs: NOTIFICATION_TIMEOUT_MS,
  };
}

export function getNotificationChannel(
  kind: NotificationChannelKind,
  transports: NotificationTransports = defaultNotificationTransports(),
): NotificationChannel {
  return registry[kind](transports);
}
