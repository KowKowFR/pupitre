import type { UiLanguage } from '../i18n.js';
import type { InlineImage } from './brand.js';
import type { ChannelConfig, NotificationChannelKind } from './catalog.js';
import type { NotificationDigest } from './digest.js';
import type { NotificationMessage } from './message.js';

/**
 * The contract a way of warning someone must fulfill.
 *
 * The same structuring rule as for drivers and scanners: an implementation
 * **imports nothing** from `packages/db`, nor `apps/web`, nor Redis. It receives
 * an already validated configuration, a neutral message, and it delivers. It is
 * the caller that decides to record the result or discard it.
 *
 * Adding a channel must be done by adding a class and an entry in the factory,
 * without touching the worker, the routes or the screen.
 */

/**
 * A channel's resolved configuration: the public part read from the database,
 * the secret part decrypted just before the call. Both are kept apart until
 * here — that is what guarantees no intermediate layer handles a secret by
 * mistake.
 */
export type ResolvedChannelConfig = {
  config: ChannelConfig;
  secrets: ChannelConfig;
};

export type NotificationTestResult = {
  ok: boolean;
  /** A sentence, displayable as is. Already scrubbed of any secret. */
  detail: string;
};

export interface NotificationChannel {
  readonly kind: NotificationChannelKind;

  /**
   * Checks that the configuration works **without delivering** a visible message,
   * when the protocol offers such a probe (SMTP handshake, Telegram `getMe`,
   * reading the Discord webhook).
   *
   * A channel that offers none says so — it does not pretend to have checked.
   *
   * The language is passed here, whereas `send()` and `sendDigest()` read it from
   * the payload they deliver: a probe carries no message, and yet its verdict is
   * shown in the panel. It is the caller that resolves it, `packages/core` never
   * reading the instance settings.
   */
  test(resolved: ResolvedChannelConfig, language?: UiLanguage): Promise<NotificationTestResult>;

  /** Delivers a single alert. Throws a `NotificationError` on failure. */
  send(resolved: ResolvedChannelConfig, message: NotificationMessage): Promise<void>;

  /**
   * Delivers a **digest** — several events of the same type, held during a
   * grouping window.
   *
   * A distinct and **mandatory** method, not a flag on `send()`: a digest carries
   * a list, a window and a total, and each protocol renders them differently. An
   * email can list a hundred lines, a Telegram message must fit on screen.
   * Squeezing all that into a `NotificationMessage` would force each channel to
   * guess that a text hides a list — the abstraction leak this layer forbids.
   *
   * Mandatory so that the compiler refuses a channel that could alert but not
   * summarize: it would then send fifty messages where the others send one.
   */
  sendDigest(resolved: ResolvedChannelConfig, digest: NotificationDigest): Promise<void>;
}

/** A failure attributable to a channel, with the context useful for diagnosis. */
export class NotificationError extends Error {
  constructor(
    message: string,
    readonly channel: NotificationChannelKind,
    readonly phase: 'config' | 'connect' | 'send',
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'NotificationError';
  }
}

// ─── transports injectables ───────────────────────────────────────────────────

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** What an SMTP send needs, reduced to the essentials. */
export type SmtpEnvelope = {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
  /** Attached images, shown in the HTML by their `cid`: the Pupitre tile. */
  inlineImages?: InlineImage[];
};

export type SmtpOptions = {
  host: string;
  port: number;
  /** `true` = implicit SMTPS (the session opens already encrypted). */
  secure: boolean;
  requireTls: boolean;
  rejectUnauthorized: boolean;
  auth: { user: string; pass: string } | null;
  timeoutMs: number;
};

/**
 * The SMTP transport, seen as two functions. That is what makes the layer
 * testable without a server: a test provides a fake that records the envelope
 * and returns, without opening a socket.
 */
export type SmtpTransport = {
  verify: () => Promise<void>;
  send: (envelope: SmtpEnvelope) => Promise<void>;
  close: () => void;
};

export type SmtpTransportFactory = (options: SmtpOptions) => SmtpTransport;

export type NotificationTransports = {
  fetch: FetchLike;
  smtp: SmtpTransportFactory;
  /** Upper bound of a network call. The worker sets it, the channels apply it. */
  timeoutMs: number;
};

// ─── expurgation ──────────────────────────────────────────────────────────────

/**
 * Shapes tokens take at the targeted providers, including **masked** by them.
 *
 * Seen elsewhere in this repository (`@pupitre/core/ai`): on a refused key, a
 * provider returns "Incorrect API key provided: sk-abcd1234***…***wxyz" — that
 * is part of the key, in clear, in a message we then relay in an HTTP response
 * and in the audit log. The provider's mask is not our mask.
 *
 * Here: the Telegram bot token (`123456789:AA…`), which appears as is in the URL
 * the HTTP client copies into its error messages, and the trailing token of a
 * Discord webhook URL.
 */
const TOKEN_LIKE: readonly RegExp[] = [
  // Telegram bot token, including when it is still in the URL.
  /\b\d{6,12}:[A-Za-z0-9_-]{20,}/g,
  // A Discord webhook's token — last segment, after the identifier.
  /(\/api\/webhooks\/\d+\/)[A-Za-z0-9_.-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
];

/**
 * Removes from a message everything that looks like a secret, before it reaches
 * a response, a log, the audit log or the `last_error` column.
 *
 * Two passes, in this order: the exact values we know — the only real guarantee
 * —, then the recognizable shapes, which catch the variants truncated or
 * reformatted by the remote service.
 */
const MASK: Record<UiLanguage, string> = { fr: '[secret masqué]', en: '[redacted secret]' };

export function redactSecrets(
  text: string,
  secrets: ChannelConfig = {},
  language: UiLanguage = 'fr',
): string {
  const mask = MASK[language];
  let result = text;

  for (const value of Object.values(secrets)) {
    const secret = typeof value === 'string' ? value.trim() : '';
    if (secret.length < 6) continue;
    result = result.split(secret).join(mask);
    // A Discord webhook URL also goes through messages truncated at its token: we
    // therefore also mask what follows the last `/`.
    const tail = secret.slice(secret.lastIndexOf('/') + 1);
    if (tail.length >= 10 && tail !== secret) result = result.split(tail).join(mask);
  }

  for (const pattern of TOKEN_LIKE) {
    result = result.replace(pattern, (_match: string, prefix: string | undefined) =>
      prefix ? `${prefix}${mask}` : mask,
    );
  }

  return result;
}

/**
 * Any error's message, truncated and scrubbed.
 *
 * The cause is unfolded one level, and it is not for comfort: `fetch` reports
 * "fetch failed" for *every* transport failure — silent DNS, connection refused,
 * TLS rejected, timeout —, and stores the real reason in `cause`. A
 * `last_error` that says "fetch failed" does not make the failure visible, it
 * only mentions it.
 */
export function describeFailure(
  error: unknown,
  secrets: ChannelConfig = {},
  language: UiLanguage = 'fr',
): string {
  let raw = error instanceof Error ? error.message : typeof error === 'string' ? error : String(error);

  const cause: unknown = error instanceof Error ? error.cause : undefined;
  if (cause instanceof Error && cause.message.length > 0 && !raw.includes(cause.message)) {
    raw = `${raw} : ${cause.message}`;
  } else if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    raw = `${raw} : ${String((cause as { code: unknown }).code)}`;
  }

  return redactSecrets(raw, secrets, language).slice(0, 400);
}

// ─── what a send carries ──────────────────────────────────────────────────────

/**
 * A delivery's payload: a single alert, or a digest.
 *
 * The discriminant lives here rather than in the worker: it is the channels'
 * layer that knows both shapes, and it must stay the only place where we choose
 * between `send()` and `sendDigest()`.
 */
export type NotificationPayload =
  | { readonly type: 'event'; readonly message: NotificationMessage }
  | { readonly type: 'digest'; readonly digest: NotificationDigest };

/** The **only** switch between single alert and digest, in the whole project. */
export function deliverNotification(
  channel: NotificationChannel,
  resolved: ResolvedChannelConfig,
  payload: NotificationPayload,
): Promise<void> {
  return payload.type === 'digest'
    ? channel.sendDigest(resolved, payload.digest)
    : channel.send(resolved, payload.message);
}

/** The event carried by a payload, whatever its type — for headers and logs. */
export function notificationPayloadEvent(payload: NotificationPayload): string {
  return payload.type === 'digest' ? payload.digest.event : payload.message.event;
}
