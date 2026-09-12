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
export { SmtpChannel, nodemailerTransport, smtpOptionsFrom, smtpSenderFrom } from './smtp.js';

/**
 * Fabrique de canaux de notification.
 *
 * Même forme que `getDriver()`, `getScanner()` et `getAiProviderFactory()` : un
 * registre indexé par la clé, une implémentation par canal, et **aucun**
 * `if (kind === …)` ailleurs dans le projet. Le type `Record<…>` est la
 * garantie qu'un canal déclaré au catalogue sans fabrique ne compile pas.
 *
 * Les transports sont passés à la construction plutôt qu'importés par les
 * implémentations. C'est ce qui permet à un test de fournir un faux `fetch` et
 * un faux transport SMTP, donc d'exercer la forme exacte de chaque charge utile
 * sans réseau, sans serveur d'e-mail et sans jeton.
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
 * Borne d'un appel sortant.
 *
 * Quinze secondes : un serveur SMTP lent met dix à vingt secondes à accepter
 * une session, et l'essai déclenché depuis l'écran attend la réponse (voir la
 * route `/api/notifications/channels/[id]/test`). Plus court couperait des
 * serveurs légitimes ; plus long tiendrait la requête HTTP ouverte au-delà de
 * ce qu'un opérateur accepte de regarder.
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
