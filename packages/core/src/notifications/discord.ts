import { renderMessage, type Translated, type UiLanguage } from '../i18n.js';
import type { ChannelConfig } from './catalog.js';
import {
  renderDigestItemLine,
  renderDigestOmission,
  type NotificationDigest,
} from './digest.js';
import { notificationSeverityLabel, type NotificationMessage } from './message.js';
import { httpCall, jsonField } from './http.js';
import {
  NotificationError,
  type FetchLike,
  type NotificationChannel,
  type NotificationTestResult,
  type ResolvedChannelConfig,
} from './types.js';

/**
 * Discord, through a channel webhook.
 *
 * An `embed` rather than a text message: the color bar on the left makes the
 * severity readable at a glance in a scrolling channel, and the fields line up
 * instead of getting lost in a paragraph.
 *
 * The API's limits are hard and silent — exceeding one returns a 400 without
 * saying which of the ten fields is at fault. We therefore truncate here, once,
 * rather than discover the limit in production.
 */

/**
 * What this channel adds around the neutral message: a digest's `embed` footer,
 * and the probe's two verdicts.
 */
const fr = {
  'digest.footer': '{count} alertes regroupées',
  'probe.named': 'Webhook « {name} » reconnu par Discord.',
  'probe.plain': 'Webhook reconnu par Discord.',
  'error.noUrl': 'aucune URL de webhook configurée',
} as const;

const en: Translated<typeof fr> = {
  'digest.footer': '{count} alerts grouped',
  'probe.named': 'Webhook “{name}” recognized by Discord.',
  'probe.plain': 'Webhook recognized by Discord.',
  'error.noUrl': 'no webhook URL configured',
};

const DISCORD_TEXT = { fr, en };

function t(
  language: UiLanguage,
  key: keyof typeof fr,
  vars?: Record<string, string | number>,
): string {
  return renderMessage(DISCORD_TEXT, language, key, vars);
}

const LIMIT = { title: 256, description: 4096, fieldName: 256, fieldValue: 1024, fields: 25 };

/**
 * Detailed lines of a digest in a channel.
 *
 * Fifteen: a Discord channel is read on a wide screen and scrolls back easily,
 * so one can be more generous there than on Telegram — but not fifty, or the
 * rest of the channel drowns under a single message. Omitted lines are
 * announced, as elsewhere.
 */
const DIGEST_LINES = 15;

/** Color of the side bar, as an integer — the shape Discord expects. */
const COLOR: Record<NotificationMessage['severity'], number> = {
  info: 0x3b6fd4,
  warning: 0xb7791f,
  critical: 0xc0392b,
};

function clamp(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function str(config: ChannelConfig, key: string): string {
  const value = config[key];
  return typeof value === 'string' ? value.trim() : '';
}

export class DiscordChannel implements NotificationChannel {
  readonly kind = 'discord' as const;

  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly timeoutMs: number,
  ) {}

  private url(resolved: ResolvedChannelConfig, language: UiLanguage): string {
    const url = str(resolved.secrets, 'webhookUrl');
    if (url.length === 0) {
      throw new NotificationError(t(language, 'error.noUrl'), this.kind, 'config');
    }
    return url;
  }

  /**
   * A `GET` on the webhook's URL returns its description without posting anything
   * in the channel: it is exactly the probe needed, and it validates both the URL
   * and the token it contains.
   */
  async test(
    resolved: ResolvedChannelConfig,
    language: UiLanguage,
  ): Promise<NotificationTestResult> {
    try {
      const result = await httpCall({
        language,
        channel: this.kind,
        fetch: this.fetchImpl,
        url: this.url(resolved, language),
        method: 'GET',
        timeoutMs: this.timeoutMs,
        secrets: resolved.secrets,
      });
      const name = jsonField(result.text, 'name');
      // The webhook's name was written on the Discord side: it is data.
      return {
        ok: true,
        detail: name ? t(language, 'probe.named', { name }) : t(language, 'probe.plain'),
      };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof NotificationError ? error.message : String(error),
      };
    }
  }

  async send(resolved: ResolvedChannelConfig, message: NotificationMessage): Promise<void> {
    const username = str(resolved.config, 'username');

    await httpCall({
      language: message.language,
      channel: this.kind,
      fetch: this.fetchImpl,
      url: this.url(resolved, message.language),
      method: 'POST',
      timeoutMs: this.timeoutMs,
      secrets: resolved.secrets,
      body: {
        ...(username.length > 0 ? { username } : {}),
        embeds: [
          {
            title: clamp(message.title, LIMIT.title),
            description: clamp(message.body, LIMIT.description),
            color: COLOR[message.severity],
            ...(message.url ? { url: message.url } : {}),
            timestamp: message.occurredAt,
            fields: message.fields.slice(0, LIMIT.fields).map((field) => ({
              name: clamp(field.label, LIMIT.fieldName),
              value: clamp(field.value, LIMIT.fieldValue),
              // The values are identifiers and error messages: on two columns they would be
              // truncated on display.
              inline: false,
            })),
            footer: {
              text: clamp(
                `${message.instance} · ${notificationSeverityLabel(message.severity, message.language)}`,
                LIMIT.fieldValue,
              ),
            },
          },
        ],
      },
    });
  }

  /**
   * The digest: a single `embed`, the list in the `description` rather than in
   * `fields`.
   *
   * An embed's `fields` are made for short label/value pairs; fifteen of them
   * stacked produce an unreadable block, and the API refuses more than
   * twenty-five. A bulleted list in the description reads like a list — which it
   * is.
   */
  async sendDigest(resolved: ResolvedChannelConfig, digest: NotificationDigest): Promise<void> {
    const username = str(resolved.config, 'username');
    const shown = digest.items.slice(0, DIGEST_LINES);
    const omission = renderDigestOmission(digest.count - shown.length, digest.language);

    const description = [
      digest.body,
      '',
      ...shown.map((item) => `• ${renderDigestItemLine(item)}`),
      ...(omission ? ['', `*${omission}*`] : []),
    ].join('\n');

    await httpCall({
      language: digest.language,
      channel: this.kind,
      fetch: this.fetchImpl,
      url: this.url(resolved, digest.language),
      method: 'POST',
      timeoutMs: this.timeoutMs,
      secrets: resolved.secrets,
      body: {
        ...(username.length > 0 ? { username } : {}),
        embeds: [
          {
            title: clamp(digest.title, LIMIT.title),
            description: clamp(description, LIMIT.description),
            color: COLOR[digest.severity],
            ...(digest.url ? { url: digest.url } : {}),
            timestamp: digest.occurredAt,
            fields: [],
            footer: {
              text: clamp(
                `${digest.instance} · ${notificationSeverityLabel(digest.severity, digest.language)} · ${t(digest.language, 'digest.footer', { count: digest.count })}`,
                LIMIT.fieldValue,
              ),
            },
          },
        ],
      },
    });
  }
}
