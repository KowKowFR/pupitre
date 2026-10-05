import { renderMessage, type Translated, type UiLanguage } from '../i18n.js';
import type { ChannelConfig } from './catalog.js';
import {
  digestTimeOfDay,
  renderDigestOmission,
  type NotificationDigest,
} from './digest.js';
import { notificationOpenLabel, type NotificationMessage } from './message.js';
import { httpCall, jsonField } from './http.js';
import {
  NotificationError,
  type FetchLike,
  type NotificationChannel,
  type NotificationTestResult,
  type ResolvedChannelConfig,
} from './types.js';

/**
 * Telegram, through the Bot API.
 *
 * ── MarkdownV2 escapes ──────────────────────────────────────────────────────
 * MarkdownV2 requires **eighteen** characters to be preceded by a backslash,
 * including the period, the dash and the exclamation mark. In other words: any
 * ordinary sentence fails the call with an incomprehensible "can't parse
 * entities", and an incident message that does not go out is worse than a badly
 * formatted message.
 *
 * Hence two rules, held here and nowhere else:
 *   — everything that comes from the neutral message is escaped character by
 *     character;
 *   — the only unescaped markup signs are those *this file* writes itself (`*`
 *     for the title, `` ` `` for values).
 */

/**
 * What this channel adds around the neutral message: the short sentence that
 * replaces a digest's body on a phone, and `getMe`'s two verdicts.
 */
const fr = {
  'digest.header': '{count} alertes entre {start} et {end} (UTC), regroupées.',
  'probe.named':
    'Jeton valide — bot @{bot}. L’identifiant de conversation, lui, n’est vérifiable que par un envoi.',
  'probe.plain': 'Jeton accepté par l’API Bot.',
  'error.noToken': 'aucun jeton de bot configuré',
} as const;

const en: Translated<typeof fr> = {
  'digest.header': '{count} alerts between {start} and {end} (UTC), grouped.',
  'probe.named':
    'Token valid — bot @{bot}. The chat ID, though, is only proven by an actual send.',
  'probe.plain': 'Token accepted by the Bot API.',
  'error.noToken': 'no bot token configured',
};

const TELEGRAM_TEXT = { fr, en };

function t(
  language: UiLanguage,
  key: keyof typeof fr,
  vars?: Record<string, string | number>,
): string {
  return renderMessage(TELEGRAM_TEXT, language, key, vars);
}

/** MarkdownV2's eighteen reserved characters, to the letter. */
const RESERVED = /[_*[\]()~`>#+\-=|{}.!\\]/g;

export function escapeMarkdownV2(value: string): string {
  return value.replace(RESERVED, (match) => `\\${match}`);
}

const SEVERITY_MARK: Record<NotificationMessage['severity'], string> = {
  info: 'ℹ️',
  warning: '⚠️',
  critical: '🔴',
};

function renderMarkdown(message: NotificationMessage): string {
  const lines = [
    `${SEVERITY_MARK[message.severity]} *${escapeMarkdownV2(message.title)}*`,
    '',
    escapeMarkdownV2(message.body),
  ];

  if (message.fields.length > 0) {
    lines.push('');
    for (const field of message.fields) {
      lines.push(`*${escapeMarkdownV2(field.label)}* : \`${escapeMarkdownV2(field.value)}\``);
    }
  }

  if (message.url) {
    // A MarkdownV2 link: the label is escaped, the URL is only escaped for
    // parentheses — escaping it entirely would break the target.
    lines.push(
      '',
      `[${escapeMarkdownV2(notificationOpenLabel(message.language))}](${message.url.replace(/[()\\]/g, '\\$&')})`,
    );
  }

  lines.push('', `_${escapeMarkdownV2(`${message.instance} · ${message.occurredAt}`)}_`);

  return lines.join('\n');
}

/**
 * How many lines a digest shows here.
 *
 * Six, and the figure is a channel trade-off, not a global constant: Telegram
 * shows on a phone, in a scrolling thread. Fifty lines there are exactly as
 * unusable as fifty messages — we would have moved the noise, not reduced it.
 * The omitted lines are **announced**; email lists them all.
 */
const DIGEST_LINES = 6;

/** The Bot API's hard limit: 4096 characters. We stop well before. */
const TEXT_LIMIT = 3500;

function renderDigestMarkdown(digest: NotificationDigest): string {
  const shown = digest.items.slice(0, DIGEST_LINES);
  const omitted = digest.count - shown.length;

  const lines = [
    `${SEVERITY_MARK[digest.severity]} *${escapeMarkdownV2(digest.title)}*`,
    '',
    // The full body would explain the trade-off in five sentences: on a phone, that
    // is what pushes the list off the screen. We keep the only sentence that would
    // be missing for understanding.
    escapeMarkdownV2(
      t(digest.language, 'digest.header', {
        count: digest.count,
        start: digestTimeOfDay(digest.windowStartedAt),
        end: digestTimeOfDay(digest.windowEndedAt),
      }),
    ),
    '',
  ];

  for (const item of shown) {
    lines.push(
      `• \`${escapeMarkdownV2(digestTimeOfDay(item.occurredAt))}\` ${escapeMarkdownV2(item.label)}` +
        `${item.detail ? ` — ${escapeMarkdownV2(item.detail)}` : ''}`,
    );
  }

  const omission = renderDigestOmission(omitted, digest.language);
  if (omission) lines.push('', `_${escapeMarkdownV2(omission)}_`);

  if (digest.url) {
    lines.push(
      '',
      `[${escapeMarkdownV2(notificationOpenLabel(digest.language))}](${digest.url.replace(/[()\\]/g, '\\$&')})`,
    );
  }

  lines.push('', `_${escapeMarkdownV2(`${digest.instance} · ${digest.occurredAt}`)}_`);

  const text = lines.join('\n');
  return text.length <= TEXT_LIMIT ? text : `${text.slice(0, TEXT_LIMIT - 1)}…`;
}

const DEFAULT_API = 'https://api.telegram.org';

function str(config: ChannelConfig, key: string): string {
  const value = config[key];
  return typeof value === 'string' ? value.trim() : '';
}

export class TelegramChannel implements NotificationChannel {
  readonly kind = 'telegram' as const;

  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly timeoutMs: number,
  ) {}

  private endpoint(
    resolved: ResolvedChannelConfig,
    method: string,
    language: UiLanguage,
  ): string {
    const base = (str(resolved.config, 'apiBaseUrl') || DEFAULT_API).replace(/\/+$/, '');
    const token = str(resolved.secrets, 'botToken');
    if (token.length === 0) {
      throw new NotificationError(t(language, 'error.noToken'), this.kind, 'config');
    }
    return `${base}/bot${token}/${method}`;
  }

  /**
   * `getMe`: Telegram's only probe that posts nothing in the conversation. It
   * checks the token is valid; it says nothing about the chat identifier, which
   * only a real send can validate.
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
        url: this.endpoint(resolved, 'getMe', language),
        method: 'GET',
        timeoutMs: this.timeoutMs,
        secrets: resolved.secrets,
      });
      const username = jsonField(result.text, 'result', 'username');
      return {
        ok: true,
        // The bot's name is data: it is copied, not translated.
        detail: username
          ? t(language, 'probe.named', { bot: username })
          : t(language, 'probe.plain'),
      };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof NotificationError ? error.message : String(error),
      };
    }
  }

  async send(resolved: ResolvedChannelConfig, message: NotificationMessage): Promise<void> {
    await httpCall({
      language: message.language,
      channel: this.kind,
      fetch: this.fetchImpl,
      url: this.endpoint(resolved, 'sendMessage', message.language),
      method: 'POST',
      timeoutMs: this.timeoutMs,
      secrets: resolved.secrets,
      body: {
        chat_id: str(resolved.config, 'chatId'),
        text: renderMarkdown(message),
        parse_mode: 'MarkdownV2',
        // The preview would unfold the panel's URL in the middle of the conversation,
        // which drowns the message under a pointless thumbnail.
        link_preview_options: { is_disabled: true },
      },
    });
  }

  /**
   * The digest, short by construction: a title, a sentence, six lines, and the
   * number of omitted lines. It is the channel where "staying short" wins over
   * "saying everything" — and where honesty therefore requires saying what is
   * left out.
   */
  async sendDigest(resolved: ResolvedChannelConfig, digest: NotificationDigest): Promise<void> {
    await httpCall({
      language: digest.language,
      channel: this.kind,
      fetch: this.fetchImpl,
      url: this.endpoint(resolved, 'sendMessage', digest.language),
      method: 'POST',
      timeoutMs: this.timeoutMs,
      secrets: resolved.secrets,
      body: {
        chat_id: str(resolved.config, 'chatId'),
        text: renderDigestMarkdown(digest),
        parse_mode: 'MarkdownV2',
        link_preview_options: { is_disabled: true },
      },
    });
  }
}
