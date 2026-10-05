import { z } from 'zod';
import {
  DEFAULT_UI_LANGUAGE,
  UI_LANGUAGES,
  renderMessage,
  type Translated,
  type UiLanguage,
  type Vars,
} from '../i18n.js';

/**
 * The neutral message — everything a channel receives, and nothing more.
 *
 * A channel receives **neither** email HTML, **nor** Telegram Markdown, **nor**
 * a Discord `embed`: it receives a title, a body, a severity, a few fields and a
 * link. It is each implementation that knows how to render that in its protocol
 * — the email as text *and* HTML, Discord as a colored `embed`, Telegram as
 * `MarkdownV2` with its escapes, the webhook as raw JSON.
 *
 * The rule that holds the abstraction: if the calling code starts writing HTML
 * or asterisks, the abstraction leaks and it must be fixed here, not there.
 *
 * This module only depends on Zod and the translation mechanism — two modules
 * without dependencies: it is re-exported from the root of `@pupitre/core`,
 * hence readable by the Next panel without pulling `nodemailer` into its graph.
 * The implementations live under `@pupitre/core/notifications`.
 */

export const NOTIFICATION_SEVERITIES = ['info', 'warning', 'critical'] as const;

export const notificationSeveritySchema = z.enum(NOTIFICATION_SEVERITIES);
export type NotificationSeverity = z.infer<typeof notificationSeveritySchema>;

/**
 * The words **every** channel adds around the neutral message: the severity
 * spelled out, the link to the panel, the test message. They live here because
 * four protocols render them differently but say them the same way.
 */
const fr = {
  'severity.info': 'Information',
  'severity.warning': 'Avertissement',
  'severity.critical': 'Critique',
  'openInPanel': 'Ouvrir dans le panel',
  'test.title': "Message d'essai — {channel}",
  'test.body':
    "Si vous lisez ceci, le canal est correctement configuré : le panel sait joindre " +
    'ce destinataire. Aucun incident ne s’est produit, personne n’a rien à faire.',
  'test.field.channel': 'Canal',
  'test.field.instance': 'Instance',
} as const;

const en: Translated<typeof fr> = {
  'severity.info': 'Information',
  'severity.warning': 'Warning',
  'severity.critical': 'Critical',
  'openInPanel': 'Open in the panel',
  'test.title': 'Test message — {channel}',
  'test.body':
    'If you are reading this, the channel is set up correctly: the panel can reach this ' +
    'recipient. Nothing happened, nobody has anything to do.',
  'test.field.channel': 'Channel',
  'test.field.instance': 'Instance',
};

const MESSAGE_TEXT = { fr, en };

function t(language: UiLanguage, key: keyof typeof fr, vars?: Vars): string {
  return renderMessage(MESSAGE_TEXT, language, key, vars);
}

/** The severity spelled out, in the instance's language. */
export function notificationSeverityLabel(
  severity: NotificationSeverity,
  language: UiLanguage,
): string {
  return t(language, `severity.${severity}`);
}

/** The label of the link to the panel — a channel never writes it itself. */
export function notificationOpenLabel(language: UiLanguage): string {
  return t(language, 'openInPanel');
}

/**
 * The French table, kept for callers that do not carry a language yet.
 * `notificationSeverityLabel()` is what should be called.
 */
export const NOTIFICATION_SEVERITY_LABELS: Record<NotificationSeverity, string> = {
  info: fr['severity.info'],
  warning: fr['severity.warning'],
  critical: fr['severity.critical'],
};

/**
 * A label / value pair. Deliberately strings: the channel does not have to guess
 * how to render a number, a date or a boolean, and two channels would not render
 * them the same way. Formatting belongs to whoever composes the message, once,
 * for everybody.
 */
export const notificationFieldSchema = z.object({
  label: z.string().trim().min(1).max(60),
  value: z.string().trim().min(1).max(500),
});

export type NotificationField = z.infer<typeof notificationFieldSchema>;

export const notificationMessageSchema = z.object({
  /** Key of the event behind the message — never a translated label. */
  event: z.string().min(1).max(80),
  severity: notificationSeveritySchema,
  title: z.string().trim().min(1).max(200),
  /** Two or three sentences. Plain text: no markup syntax. */
  body: z.string().trim().min(1).max(2000),
  fields: z.array(notificationFieldSchema).max(12).default([]),
  /** Absolute link to the panel screen that shows the object. `null` if there is none. */
  url: z.string().url().max(500).nullable().default(null),
  /**
   * Name of the sending instance. Two panels writing to the same Discord channel
   * are indistinguishable without it — and it is a common case.
   */
  instance: z.string().trim().min(1).max(60),
  occurredAt: z.string().datetime(),
  /**
   * Language in which the message was composed.
   *
   * It travels with it because the channel writes its own words on top — the
   * severity spelled out, "Open in the panel" — and does so later, in another
   * task, without access to the settings. A default rather than a required field:
   * a task already queued before this field must keep deserializing, otherwise the
   * alert is lost.
   */
  language: z.enum(UI_LANGUAGES).default(DEFAULT_UI_LANGUAGE),
});

export type NotificationMessage = z.infer<typeof notificationMessageSchema>;

/**
 * Plain text rendering, shared by every channel that needs it (an email's
 * `text/plain` part, the fallback of a channel that refuses markup).
 *
 * It lives here and not in each implementation because it is the rendering *of
 * the neutral message itself*, without protocol: duplicating it three times
 * would make three versions of the same thing diverge.
 */
export function renderPlainText(message: NotificationMessage): string {
  const lines = [message.title, '', message.body];

  if (message.fields.length > 0) {
    lines.push('');
    for (const field of message.fields) lines.push(`${field.label} : ${field.value}`);
  }

  if (message.url) {
    lines.push('', message.url);
  }

  lines.push(
    '',
    `— ${message.instance} · ${notificationSeverityLabel(message.severity, message.language).toLowerCase()} · ${message.occurredAt}`,
  );

  return lines.join('\n');
}

/**
 * Test message. It carries a real severity and real fields: a test that did not
 * exercise the complete rendering would not prove much about the channel.
 */
export function testNotificationMessage(options: {
  instance: string;
  panelUrl: string | null;
  channelName: string;
  /** The instance's language. The panel resolves it before queuing the test. */
  language: UiLanguage;
}): NotificationMessage {
  const language = options.language;

  return notificationMessageSchema.parse({
    event: 'notification.test',
    severity: 'info',
    title: t(language, 'test.title', { channel: options.channelName }),
    body: t(language, 'test.body'),
    fields: [
      // The channel's **name** is data: the operator wrote it, we copy it as is. Only
      // its label is translated.
      { label: t(language, 'test.field.channel'), value: options.channelName },
      { label: t(language, 'test.field.instance'), value: options.instance },
    ],
    url: options.panelUrl ? `${options.panelUrl.replace(/\/+$/, '')}/admin/settings/notifications` : null,
    instance: options.instance,
    occurredAt: new Date().toISOString(),
    language,
  });
}
