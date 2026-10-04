import {
  DEFAULT_UI_LANGUAGE,
  renderMessage,
  type Translated,
  type UiLanguage,
} from '../i18n.js';
import type { ChannelConfig } from './catalog.js';
import { notificationDigestOmitted, type NotificationDigest } from './digest.js';
import type { NotificationMessage } from './message.js';
import { httpCall } from './http.js';
import {
  NotificationError,
  type FetchLike,
  type NotificationChannel,
  type NotificationTestResult,
  type ResolvedChannelConfig,
} from './types.js';

/**
 * Generic webhook: the neutral message, as JSON, as is.
 *
 * It is the only channel that formats nothing — and that is its reason for
 * being: what it delivers is exactly the structure the other three translate,
 * which also makes it the best way to check what the panel emits.
 *
 * The payload is **versioned**. A consumer is written once, and the day the
 * message's shape changes, it can see it rather than silently fail on a field
 * that disappeared.
 */
const PAYLOAD_VERSION = 1;

/**
 * This channel's only two sentences. The payload has no language: it is JSON
 * meant for a program.
 */
const fr = {
  'probe.none':
    'Un webhook générique n’offre aucune sonde qui ne soit pas une livraison : ' +
    'seul l’envoi d’essai ci-dessous prouve que la cible répond.',
  'error.noUrl': 'aucune URL configurée',
} as const;

const en: Translated<typeof fr> = {
  'probe.none':
    'A plain webhook offers no probe that is not a delivery: only the test send below ' +
    'proves the target answers.',
  'error.noUrl': 'no URL configured',
};

const WEBHOOK_TEXT = { fr, en };

function t(language: UiLanguage, key: keyof typeof fr): string {
  return renderMessage(WEBHOOK_TEXT, language, key);
}

function str(config: ChannelConfig, key: string): string {
  const value = config[key];
  return typeof value === 'string' ? value.trim() : '';
}

export class WebhookChannel implements NotificationChannel {
  readonly kind = 'webhook' as const;

  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly timeoutMs: number,
  ) {}

  private target(resolved: ResolvedChannelConfig, language: UiLanguage): string {
    const url = str(resolved.config, 'url');
    if (url.length === 0) {
      throw new NotificationError(t(language, 'error.noUrl'), this.kind, 'config');
    }
    return url;
  }

  private headers(
    resolved: ResolvedChannelConfig,
    routing: { event: string; severity: string; digest: boolean },
  ) {
    const token = str(resolved.secrets, 'token');
    return {
      // Three routing headers, so that a consumer can sort without deserializing the
      // body — a gateway filter, typically. The third tells a digest from an alert:
      // the two do not have the same shape, and a consumer must be able to know it
      // before parsing.
      'X-Control-Plane-Event': routing.event,
      'X-Control-Plane-Severity': routing.severity,
      'X-Control-Plane-Digest': routing.digest ? 'true' : 'false',
      ...(token.length > 0 ? { authorization: `Bearer ${token}` } : {}),
    };
  }

  /**
   * No probe possible: an arbitrary webhook offers nothing but the POST itself,
   * and probing it would amount to delivering. We say so rather than pretend to
   * have checked — it is the test send that is authoritative here.
   */
  test(
    resolved: ResolvedChannelConfig,
    language: UiLanguage = DEFAULT_UI_LANGUAGE,
  ): Promise<NotificationTestResult> {
    this.target(resolved, language);
    return Promise.resolve({ ok: true, detail: t(language, 'probe.none') });
  }

  async send(resolved: ResolvedChannelConfig, message: NotificationMessage): Promise<void> {
    await httpCall({
      language: message.language,
      channel: this.kind,
      fetch: this.fetchImpl,
      url: this.target(resolved, message.language),
      method: 'POST',
      timeoutMs: this.timeoutMs,
      secrets: resolved.secrets,
      headers: this.headers(resolved, {
        event: message.event,
        severity: message.severity,
        digest: false,
      }),
      body: { version: PAYLOAD_VERSION, type: 'event', ...message },
    });
  }

  /**
   * The digest, as JSON, **whole**.
   *
   * It is the only channel that truncates nothing: its target is a program, not a
   * screen, and a program that receives "and 42 others" can do nothing with it. It
   * therefore receives `items` in full (within the storage limit) and `omitted`,
   * which says how many lines were never held — the only loss that really exists,
   * and it is named.
   */
  async sendDigest(resolved: ResolvedChannelConfig, digest: NotificationDigest): Promise<void> {
    await httpCall({
      language: digest.language,
      channel: this.kind,
      fetch: this.fetchImpl,
      url: this.target(resolved, digest.language),
      method: 'POST',
      timeoutMs: this.timeoutMs,
      secrets: resolved.secrets,
      headers: this.headers(resolved, {
        event: digest.event,
        severity: digest.severity,
        digest: true,
      }),
      body: {
        version: PAYLOAD_VERSION,
        ...digest,
        omitted: notificationDigestOmitted(digest),
      },
    });
  }
}
