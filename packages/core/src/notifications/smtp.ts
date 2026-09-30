import nodemailer from 'nodemailer';
import {
  DEFAULT_UI_LANGUAGE,
  renderMessage,
  type Translated,
  type UiLanguage,
} from '../i18n.js';
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

/**
 * Ce que ce canal ajoute autour du message neutre. Trois phrases : le mot qui
 * marque un résumé dans l'en-tête, le verdict de la poignée de main, et le
 * refus quand aucun destinataire n'est configuré.
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

/** Échappement HTML. Le contenu vient d'une erreur de déploiement : rien n'est sûr. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Teinte de l'encadré et de l'étiquette, par gravité : la couleur dit l'état,
 * et rien d'autre. Le filet prend la teinte pleine, l'étiquette sa variante
 * lisible sur blanc.
 *
 * En dur plutôt que par variables CSS : les clients d'e-mail ne connaissent ni
 * les variables, ni les feuilles externes, ni la moitié des sélecteurs. Le
 * style en ligne est le seul qui traverse.
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
 * Le résumé, en HTML.
 *
 * L'e-mail est le seul canal qui peut **tout** lister : on y déroule donc
 * l'intégralité des lignes retenues, sans troncature de politesse. C'est
 * précisément sa valeur dans le dispositif — quand Telegram dit « et 42
 * autres », c'est dans la boîte de réception qu'on va lire lesquelles.
 *
 * Une `<ol>` et non une `<table>` : la liste peut faire cent lignes, et une
 * table de cent lignes à deux colonnes est illisible sur un téléphone.
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
        // Les images du HTML voyagent avec le message, référencées par `cid:`.
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
 * Les réglages de connexion, dérivés du champ « Chiffrement ».
 *
 * `secure` (SMTPS implicite) et `requireTLS` (STARTTLS obligatoire) ne sont
 * pas interchangeables : le premier ouvre la session déjà chiffrée, le second
 * l'élève après le premier échange et **échoue** si le serveur ne le propose
 * pas. Laisser nodemailer choisir opportunistement reviendrait à accepter en
 * silence une session en clair sur un serveur mal configuré.
 *
 * Fonction exportée plutôt que méthode privée depuis que les e-mails
 * transactionnels du cycle de vie des comptes (invitation, réinitialisation)
 * **empruntent le transport** d'un canal SMTP sans emprunter son destinataire.
 * Les deux chemins doivent dériver les mêmes réglages de la même configuration :
 * une seconde copie de ces six lignes finirait par diverger, et la divergence
 * s'appellerait « les invitations partent en clair alors que les alertes sont
 * chiffrées ».
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

/** Adresse d'expéditeur déclarée sur le canal. Vide si le canal n'en porte pas. */
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
    language: UiLanguage = DEFAULT_UI_LANGUAGE,
  ): Promise<NotificationTestResult> {
    const transport = this.transport(this.options(resolved));
    try {
      await transport.verify();
      return {
        ok: true,
        detail: t(language, 'probe.ok', { host: str(resolved.config, 'host') }),
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
        // Le nom de l'instance en tête du sujet : c'est ce qui permet de trier
        // dans une boîte qui reçoit les alertes de plusieurs panels.
        subject: `[${message.instance}] ${message.title}`,
        text: renderPlainText(message),
        html: renderHtml(message),
        inlineImages: [BRAND_MARK],
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

  /**
   * Le résumé emprunte exactement le même chemin que l'alerte unitaire : même
   * enveloppe, mêmes en-têtes de service, deux parties. Seule la mise en forme
   * change — une liste au lieu d'un tableau de champs.
   *
   * Le sujet annonce le nombre : `[Panel] 12 × Déploiement en échec — résumé`.
   * C'est ce que lit un opérateur dans la liste de sa boîte, avant même
   * d'ouvrir, et c'est ce qui doit lui dire que douze incidents l'attendent.
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
        // Aucune borne : l'e-mail est le canal qui liste tout. Les canaux
        // courts renvoient ici implicitement, par leur « et N autres ».
        text: renderDigestPlainText(digest),
        html: renderDigestHtml(digest),
        inlineImages: [BRAND_MARK],
        headers: {
          'X-Control-Plane-Event': digest.event,
          'X-Control-Plane-Severity': digest.severity,
          // En-têtes propres au résumé : un filtre côté client peut ranger les
          // résumés ailleurs que les alertes, ce qui est un besoin réel.
          'X-Control-Plane-Digest': 'true',
          'X-Control-Plane-Digest-Count': String(digest.count),
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
