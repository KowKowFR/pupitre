import nodemailer from 'nodemailer';
import { renderMessage, type Translated, type UiLanguage } from '../i18n.js';
import { BRAND_MARK, EMAIL_COLORS, brandHeaderHtml } from './brand.js';
import { splitMailboxList, type ChannelConfig } from './catalog.js';
import {
  notificationDigestOmitted,
  renderDigestOmission,
  renderDigestPlainText,
  type NotificationDigest,
} from './digest.js';
import {
  notificationOpenLabel,
  notificationSeverityLabel,
  renderPlainText,
  type NotificationMessage,
} from './message.js';
import {
  NotificationError,
  describeFailure,
  type NotificationChannel,
  type NotificationTestResult,
  type ResolvedChannelConfig,
  type SmtpEnvelope,
  type SmtpOptions,
  type SmtpTransportFactory,
} from './types.js';

/**
 * Email, through an SMTP server.
 *
 * The message goes out in two versions: `text/plain` and `text/html`, in the
 * same multipart message. It is not a luxury — a text-mode client, a relay that
 * strips HTML, a phone notification that only shows the beginning: in all three
 * cases it is the text version that is read.
 *
 * The HTML is written **here**, and nowhere else. It is the abstraction's
 * checkpoint: the day the caller composes HTML, the layer has leaked.
 */

/**
 * What this channel adds around the neutral message. Three sentences: the word
 * that marks a digest in the header, the handshake's verdict, and the refusal
 * when no recipient is configured.
 */
const fr = {
  'digestTag': 'résumé',
  'probe.ok': 'Serveur {host} joignable, authentification acceptée.',
  'error.noRecipient': 'aucun destinataire configuré',
} as const;

const en: Translated<typeof fr> = {
  'digestTag': 'digest',
  'probe.ok': 'Server {host} reachable, authentication accepted.',
  'error.noRecipient': 'no recipient configured',
};

const SMTP_TEXT = { fr, en };

function t(language: UiLanguage, key: keyof typeof fr, vars?: Record<string, string>): string {
  return renderMessage(SMTP_TEXT, language, key, vars);
}

/** HTML escaping. The content comes from a deployment error: nothing is safe. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Tint of the box and the label, per severity: the color says the state, and
 * nothing else. The rule takes the full tint, the label its variant readable on
 * white.
 *
 * Hard-coded rather than through CSS variables: email clients know neither
 * variables, nor external sheets, nor half of the selectors. Inline style is the
 * only one that gets through.
 */
const ACCENT: Record<NotificationMessage['severity'], { line: string; text: string }> = {
  info: { line: EMAIL_COLORS.accent, text: EMAIL_COLORS.accentText },
  warning: { line: EMAIL_COLORS.warn, text: EMAIL_COLORS.warnText },
  critical: { line: EMAIL_COLORS.danger, text: EMAIL_COLORS.dangerText },
};

const C = EMAIL_COLORS;

function renderHtml(message: NotificationMessage): string {
  const rows = message.fields
    .map(
      (field) =>
        `<tr>` +
        `<td style="padding:4px 12px 4px 0;color:${C.text3};font-size:13px;white-space:nowrap;vertical-align:top">${escapeHtml(field.label)}</td>` +
        `<td style="padding:4px 0;font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-word">${escapeHtml(field.value)}</td>` +
        `</tr>`,
    )
    .join('');

  const lang = message.language;

  const link = message.url
    ? `<p style="margin:20px 0 0"><a href="${escapeHtml(message.url)}" style="color:${C.accentText};font-size:14px">${escapeHtml(notificationOpenLabel(lang))}</a></p>`
    : '';

  return [
    `<!doctype html><html lang="${lang}"><body style="margin:0;background:${C.bg};padding:24px;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:${C.text}">`,
    `<div style="max-width:560px;margin:0 auto;background:${C.surface};border-radius:12px;border:1px solid ${C.border};border-left:4px solid ${ACCENT[message.severity].line};padding:20px 24px">`,
    brandHeaderHtml(message.instance),
    `<div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:${ACCENT[message.severity].text};font-weight:600">${escapeHtml(notificationSeverityLabel(message.severity, lang))}</div>`,
    `<h1 style="margin:6px 0 12px;font-size:18px;line-height:1.3">${escapeHtml(message.title)}</h1>`,
    `<p style="margin:0;font-size:14px;line-height:1.55;color:${C.text2}">${escapeHtml(message.body)}</p>`,
    rows.length > 0
      ? `<table role="presentation" style="margin-top:16px;border-collapse:collapse;width:100%">${rows}</table>`
      : '',
    link,
    `<p style="margin:22px 0 0;padding-top:14px;border-top:1px solid ${C.border};font-size:12px;color:${C.text3}">${escapeHtml(message.instance)} · ${escapeHtml(message.occurredAt)}</p>`,
    '</div></body></html>',
  ].join('');
}

/**
 * The digest, in HTML.
 *
 * Email is the only channel that can list **everything**: we therefore unroll
 * all the held lines, without a courtesy truncation. That is precisely its value
 * in the mechanism — when Telegram says "and 42 others", it is in the inbox that
 * one goes to read which.
 *
 * An `<ol>` and not a `<table>`: the list can be a hundred lines long, and a
 * two-column table of a hundred lines is unreadable on a phone.
 */
function renderDigestHtml(digest: NotificationDigest): string {
  const items = digest.items
    .map(
      (item) =>
        `<li style="margin:0 0 6px;font-size:13px;line-height:1.5">` +
        `<span style="color:${C.text3};font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${escapeHtml(item.occurredAt.slice(11, 19))}</span> ` +
        `<strong style="font-weight:600">${escapeHtml(item.label)}</strong>` +
        `${item.detail ? ` <span style="color:${C.text3}">— ${escapeHtml(item.detail)}</span>` : ''}` +
        `</li>`,
    )
    .join('');

  const lang = digest.language;
  const omission = renderDigestOmission(notificationDigestOmitted(digest), lang);

  const link = digest.url
    ? `<p style="margin:20px 0 0"><a href="${escapeHtml(digest.url)}" style="color:${C.accentText};font-size:14px">${escapeHtml(notificationOpenLabel(lang))}</a></p>`
    : '';

  return [
    `<!doctype html><html lang="${lang}"><body style="margin:0;background:${C.bg};padding:24px;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:${C.text}">`,
    `<div style="max-width:640px;margin:0 auto;background:${C.surface};border-radius:12px;border:1px solid ${C.border};border-left:4px solid ${ACCENT[digest.severity].line};padding:20px 24px">`,
    brandHeaderHtml(digest.instance),
    `<div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:${ACCENT[digest.severity].text};font-weight:600">${escapeHtml(notificationSeverityLabel(digest.severity, lang))} · ${escapeHtml(t(lang, 'digestTag'))}</div>`,
    `<h1 style="margin:6px 0 12px;font-size:18px;line-height:1.3">${escapeHtml(digest.title)}</h1>`,
    `<p style="margin:0;font-size:14px;line-height:1.55;color:${C.text2}">${escapeHtml(digest.body)}</p>`,
    `<ol style="margin:16px 0 0;padding-left:20px">${items}</ol>`,
    omission
      ? `<p style="margin:10px 0 0;font-size:13px;color:${C.text3}">${escapeHtml(omission)}</p>`
      : '',
    link,
    `<p style="margin:22px 0 0;padding-top:14px;border-top:1px solid ${C.border};font-size:12px;color:${C.text3}">${escapeHtml(digest.instance)} · ${escapeHtml(digest.windowStartedAt)} → ${escapeHtml(digest.windowEndedAt)}</p>`,
    '</div></body></html>',
  ].join('');
}

/**
 * Default transport: nodemailer.
 *
 * Isolated behind `SmtpTransportFactory` so that the layer is testable without a
 * server — a test provides a fake that records the envelope. It is also what
 * keeps `nodemailer` out of the Next panel's graph: it is only loaded when a
 * send really goes out, in the worker.
 */
export const nodemailerTransport: SmtpTransportFactory = (options) => {
  const transporter = nodemailer.createTransport({
    host: options.host,
    port: options.port,
    secure: options.secure,
    requireTLS: options.requireTls,
    tls: { rejectUnauthorized: options.rejectUnauthorized },
    ...(options.auth ? { auth: options.auth } : {}),
    connectionTimeout: options.timeoutMs,
    greetingTimeout: options.timeoutMs,
    socketTimeout: options.timeoutMs,
  });

  return {
    verify: async () => {
      await transporter.verify();
    },
    send: async (envelope: SmtpEnvelope) => {
      await transporter.sendMail({
        from: envelope.from,
        to: envelope.to,
        subject: envelope.subject,
        text: envelope.text,
        html: envelope.html,
        headers: envelope.headers,
        // The HTML's images travel with the message, referenced by `cid:`.
        attachments: (envelope.inlineImages ?? []).map((image) => ({
          filename: image.filename,
          content: Buffer.from(image.content, 'base64'),
          contentType: image.contentType,
          cid: image.cid,
          contentDisposition: 'inline' as const,
        })),
      });
    },
    close: () => {
      transporter.close();
    },
  };
};

function str(config: ChannelConfig, key: string): string {
  const value = config[key];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The connection settings, derived from the "Encryption" field.
 *
 * `secure` (implicit SMTPS) and `requireTLS` (mandatory STARTTLS) are not
 * interchangeable: the first opens the session already encrypted, the second
 * upgrades it after the first exchange and **fails** if the server does not offer
 * it. Letting nodemailer choose opportunistically would amount to silently
 * accepting a clear-text session on a misconfigured server.
 *
 * An exported function rather than a private method since the transactional
 * emails of the accounts' life cycle (invitation, reset) **borrow the
 * transport** of an SMTP channel without borrowing its recipient. Both paths must
 * derive the same settings from the same configuration: a second copy of these
 * six lines would end up diverging, and the divergence would be called
 * "invitations go out in clear while alerts are encrypted".
 */
export function smtpOptionsFrom(
  resolved: ResolvedChannelConfig,
  timeoutMs: number,
): SmtpOptions {
  const { config, secrets } = resolved;
  const security = str(config, 'security') || 'starttls';
  const user = str(config, 'user');
  const pass = str(secrets, 'password');
  const port = typeof config.port === 'number' ? config.port : Number(config.port ?? 587);

  return {
    host: str(config, 'host'),
    port: Number.isFinite(port) ? port : 587,
    secure: security === 'implicit',
    requireTls: security === 'starttls',
    rejectUnauthorized: config.rejectUnauthorized !== false,
    auth: user.length > 0 ? { user, pass } : null,
    timeoutMs,
  };
}

/** Sender address declared on the channel. Empty if the channel carries none. */
export function smtpSenderFrom(resolved: ResolvedChannelConfig): string {
  return str(resolved.config, 'from');
}

export class SmtpChannel implements NotificationChannel {
  readonly kind = 'smtp' as const;

  constructor(
    private readonly transport: SmtpTransportFactory,
    private readonly timeoutMs: number,
  ) {}

  private options(resolved: ResolvedChannelConfig): SmtpOptions {
    return smtpOptionsFrom(resolved, this.timeoutMs);
  }

  async test(
    resolved: ResolvedChannelConfig,
    language: UiLanguage,
  ): Promise<NotificationTestResult> {
    const transport = this.transport(this.options(resolved));
    try {
      await transport.verify();
      return {
        ok: true,
        detail: t(language, 'probe.ok', { host: str(resolved.config, 'host') }),
      };
    } catch (error) {
      return { ok: false, detail: describeFailure(error, resolved.secrets, language) };
    } finally {
      transport.close();
    }
  }

  async send(resolved: ResolvedChannelConfig, message: NotificationMessage): Promise<void> {
    const recipients = splitMailboxList(str(resolved.config, 'to'));
    if (recipients.length === 0) {
      throw new NotificationError(
        t(message.language, 'error.noRecipient'),
        this.kind,
        'config',
      );
    }

    const transport = this.transport(this.options(resolved));
    try {
      await transport.send({
        from: str(resolved.config, 'from'),
        to: recipients,
        // The instance's name at the start of the subject: it is what allows sorting in
        // an inbox that receives alerts from several panels.
        subject: `[${message.instance}] ${message.title}`,
        text: renderPlainText(message),
        html: renderHtml(message),
        inlineImages: [BRAND_MARK],
        // Service headers: they make filtering possible on the email client side, and
        // list unsubscription makes no sense here.
        headers: {
          'X-Control-Plane-Event': message.event,
          'X-Control-Plane-Severity': message.severity,
          'Auto-Submitted': 'auto-generated',
        },
      });
    } catch (error) {
      throw new NotificationError(
        describeFailure(error, resolved.secrets, message.language),
        this.kind,
        'send',
        error,
      );
    } finally {
      transport.close();
    }
  }

  /**
   * The digest takes exactly the same path as the single alert: same envelope,
   * same service headers, two parts. Only the formatting changes — a list instead
   * of a table of fields.
   *
   * The subject announces the number: `[Panel] 12 × Deployment failed — digest`.
   * It is what an operator reads in their inbox's list, even before opening, and
   * it is what must tell them twelve incidents are waiting.
   */
  async sendDigest(resolved: ResolvedChannelConfig, digest: NotificationDigest): Promise<void> {
    const recipients = splitMailboxList(str(resolved.config, 'to'));
    if (recipients.length === 0) {
      throw new NotificationError(
        t(digest.language, 'error.noRecipient'),
        this.kind,
        'config',
      );
    }

    const transport = this.transport(this.options(resolved));
    try {
      await transport.send({
        from: str(resolved.config, 'from'),
        to: recipients,
        subject: `[${digest.instance}] ${digest.title}`,
        // No cap: email is the channel that lists everything. The short channels
        // implicitly point here, through their "and N others".
        text: renderDigestPlainText(digest),
        html: renderDigestHtml(digest),
        inlineImages: [BRAND_MARK],
        headers: {
          'X-Control-Plane-Event': digest.event,
          'X-Control-Plane-Severity': digest.severity,
          // Digest-specific headers: a client-side filter can store digests elsewhere
          // than alerts, which is a real need.
          'X-Control-Plane-Digest': 'true',
          'X-Control-Plane-Digest-Count': String(digest.count),
          'Auto-Submitted': 'auto-generated',
        },
      });
    } catch (error) {
      throw new NotificationError(
        describeFailure(error, resolved.secrets, digest.language),
        this.kind,
        'send',
        error,
      );
    } finally {
      transport.close();
    }
  }
}
