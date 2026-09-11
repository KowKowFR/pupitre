import nodemailer from 'nodemailer';
import { splitMailboxList, type ChannelConfig } from './catalog.js';
import {
  NOTIFICATION_SEVERITY_LABELS,
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
  type SmtpTransportFactory,
} from './types.js';

/**
 * E-mail, par un serveur SMTP.
 *
 * Le message part en deux versions : `text/plain` et `text/html`, dans le même
 * message multipart. Ce n'est pas un luxe — un client en mode texte, un relais
 * qui déshabille le HTML, une notification de téléphone qui n'en montre que le
 * début : dans les trois cas c'est la version texte qui est lue.
 *
 * Le HTML est écrit **ici**, et nulle part ailleurs. C'est le point de contrôle
 * de l'abstraction : le jour où l'appelant compose du HTML, c'est que la
 * couche a fui.
 */

/** Échappement HTML. Le contenu vient d'une erreur de déploiement : rien n'est sûr. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Teinte de l'encadré, par gravité.
 *
 * En dur plutôt que par variables CSS : les clients d'e-mail ne connaissent ni
 * les variables, ni les feuilles externes, ni la moitié des sélecteurs. Le
 * style en ligne est le seul qui traverse.
 */
const ACCENT: Record<NotificationMessage['severity'], string> = {
  info: '#3b6fd4',
  warning: '#b7791f',
  critical: '#c0392b',
};

function renderHtml(message: NotificationMessage): string {
  const rows = message.fields
    .map(
      (field) =>
        `<tr>` +
        `<td style="padding:4px 12px 4px 0;color:#6b7280;font-size:13px;white-space:nowrap;vertical-align:top">${escapeHtml(field.label)}</td>` +
        `<td style="padding:4px 0;font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-word">${escapeHtml(field.value)}</td>` +
        `</tr>`,
    )
    .join('');

  const link = message.url
    ? `<p style="margin:20px 0 0"><a href="${escapeHtml(message.url)}" style="color:${ACCENT[message.severity]};font-size:14px">Ouvrir dans le panel</a></p>`
    : '';

  return [
    '<!doctype html><html lang="fr"><body style="margin:0;background:#f5f6f8;padding:24px;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#111827">',
    `<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;border:1px solid #e5e7eb;border-left:4px solid ${ACCENT[message.severity]};padding:20px 24px">`,
    `<div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:${ACCENT[message.severity]};font-weight:600">${escapeHtml(NOTIFICATION_SEVERITY_LABELS[message.severity])}</div>`,
    `<h1 style="margin:6px 0 12px;font-size:18px;line-height:1.3">${escapeHtml(message.title)}</h1>`,
    `<p style="margin:0;font-size:14px;line-height:1.55;color:#374151">${escapeHtml(message.body)}</p>`,
    rows.length > 0
      ? `<table role="presentation" style="margin-top:16px;border-collapse:collapse;width:100%">${rows}</table>`
      : '',
    link,
    `<p style="margin:22px 0 0;padding-top:14px;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af">${escapeHtml(message.instance)} · ${escapeHtml(message.occurredAt)}</p>`,
    '</div></body></html>',
  ].join('');
}

/**
 * Transport par défaut : nodemailer.
 *
 * Isolé derrière `SmtpTransportFactory` pour que la couche soit vérifiable sans
 * serveur — un test fournit un faux qui enregistre l'enveloppe. C'est aussi ce
 * qui garde `nodemailer` hors du graphe du panel Next : il n'est chargé que
 * lorsqu'un envoi part réellement, dans le worker.
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

export class SmtpChannel implements NotificationChannel {
  readonly kind = 'smtp' as const;

  constructor(
    private readonly transport: SmtpTransportFactory,
    private readonly timeoutMs: number,
  ) {}

  /**
   * Les réglages de connexion, dérivés du champ « Chiffrement ».
   *
   * `secure` (SMTPS implicite) et `requireTLS` (STARTTLS obligatoire) ne sont
   * pas interchangeables : le premier ouvre la session déjà chiffrée, le second
   * l'élève après le premier échange et **échoue** si le serveur ne le propose
   * pas. Laisser nodemailer choisir opportunistement reviendrait à accepter en
   * silence une session en clair sur un serveur mal configuré.
   */
  private options(resolved: ResolvedChannelConfig) {
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
      timeoutMs: this.timeoutMs,
    };
  }

  async test(resolved: ResolvedChannelConfig): Promise<NotificationTestResult> {
    const transport = this.transport(this.options(resolved));
    try {
      await transport.verify();
      return {
        ok: true,
        detail: `Serveur ${str(resolved.config, 'host')} joignable, authentification acceptée.`,
      };
    } catch (error) {
      return { ok: false, detail: describeFailure(error, resolved.secrets) };
    } finally {
      transport.close();
    }
  }

  async send(resolved: ResolvedChannelConfig, message: NotificationMessage): Promise<void> {
    const recipients = splitMailboxList(str(resolved.config, 'to'));
    if (recipients.length === 0) {
      throw new NotificationError('aucun destinataire configuré', this.kind, 'config');
    }

    const transport = this.transport(this.options(resolved));
    try {
      await transport.send({
        from: str(resolved.config, 'from'),
        to: recipients,
        // Le nom de l'instance en tête du sujet : c'est ce qui permet de trier
        // dans une boîte qui reçoit les alertes de plusieurs panels.
        subject: `[${message.instance}] ${message.title}`,
        text: renderPlainText(message),
        html: renderHtml(message),
        // En-têtes de service : ils rendent le filtrage possible côté client
        // d'e-mail, et le désabonnement d'une liste n'a pas de sens ici.
        headers: {
          'X-Control-Plane-Event': message.event,
          'X-Control-Plane-Severity': message.severity,
          'Auto-Submitted': 'auto-generated',
        },
      });
    } catch (error) {
      throw new NotificationError(
        describeFailure(error, resolved.secrets),
        this.kind,
        'send',
        error,
      );
    } finally {
      transport.close();
    }
  }
}
