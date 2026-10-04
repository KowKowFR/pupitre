import { z } from 'zod';
import {
  renderMessage,
  type Translated,
  type UiLanguage,
  type Vars,
} from '../i18n.js';
import { BRAND_MARK, EMAIL_COLORS, brandHeaderHtml, type InlineImage } from './brand.js';

/**
 * **Transactional** emails of the accounts' life cycle.
 *
 * They are not notifications, and the distinction is not one of vocabulary:
 *
 *   — a notification goes to a channel's **configured recipients** (the on-call
 *     inbox), describes a fact that already happened, and if it gets lost one
 *     notices later;
 *   — a transactional email goes to **one specific person**, designated by the
 *     action in progress, and it carries the only way to finish that action. If
 *     it gets lost, the person is stuck.
 *
 * Hence a separate module, a separate rendering, and above all a recipient that
 * does not come from the channel but from the caller. What is borrowed from the
 * SMTP channel is only its **transport**: server, port, encryption, credentials,
 * sender address. See `smtpOptionsFrom()` in `./smtp.ts`.
 *
 * This module only depends on Zod — not on `nodemailer`: it is re-exported from
 * the root of `@pupitre/core`, hence readable by the Next panel and by the
 * queue's schema, without pulling a transport into their graph.
 */

export const ACCOUNT_MAIL_KINDS = ['invitation', 'password_reset'] as const;

export const accountMailKindSchema = z.enum(ACCOUNT_MAIL_KINDS);
export type AccountMailKind = z.infer<typeof accountMailKindSchema>;

/**
 * What a transactional email carries.
 *
 * `url` is a **bearer link**: whoever opens it takes over the account. It
 * therefore has no business in a log, in an API response or in a task payload in
 * clear — the queue carries it encrypted, see `accountMailJobDataSchema` in
 * `../queue.js`.
 */
export const accountMailSchema = z.object({
  kind: accountMailKindSchema,
  /** The recipient's address. Only one: these messages never have a copy. */
  to: z.string().trim().min(3).max(200),
  /** Name shown in the greeting. The account always has one. */
  recipientName: z.string().trim().min(1).max(120),
  /** Name of the sending instance, as for notifications. */
  instance: z.string().trim().min(1).max(60),
  url: z.string().url().max(2000),
  expiresAt: z.string().datetime(),
  /**
   * Who triggered the send, when someone did. An invitation comes from an
   * administrator and saying so reassures; a reset comes from the person
   * themselves (or from someone who typed their address) and has no actor to
   * name.
   */
  actor: z.string().trim().min(1).max(200).nullable().default(null),
});

export type AccountMail = z.infer<typeof accountMailSchema>;

/** What an SMTP channel needs to know to post the message. */
export type AccountMailEnvelope = {
  subject: string;
  text: string;
  html: string;
  /** To attach as is to the send: the HTML refers to it through `cid:`. */
  inlineImages: InlineImage[];
};

/** HTML escaping. The recipient's name comes from a form: nothing is safe. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The text of both messages, in one place — and its translation right next to
 * it.
 *
 * ── Why the dictionary lives here and not in `apps/web` ─────────────────────
 * It is not the panel that composes these emails: it is the worker, which has
 * the SMTP transport and the only access to the link in clear. A dictionary
 * stored in `apps/web/src/i18n/messages` would therefore be out of its reach. It
 * lives where the composition lives, as the rule wants: the interface's
 * dictionaries with the interface, the domain's next to the domain.
 *
 * ── Why the language is a parameter ─────────────────────────────────────────
 * An invitation goes to someone who has no session yet: there is nobody to ask
 * for their language. It is therefore the instance's, like the alerts and like
 * the panel — and it is **passed** rather than read here, because this module
 * only depends on Zod and has no access to the database.
 */
const fr = {
  // ── The frame, shared by both messages ──────────────────────────────────
  'greeting': 'Bonjour {name},',
  'link.label': '{action} :',
  'link.validity':
    'Ce lien ne fonctionne qu’une seule fois. Il est valable {validity} et expire le {expiry}.',
  'link.fallback': 'Si le bouton ne fonctionne pas, copiez cette adresse dans votre navigateur :',
  'footer': '{instance} · message automatique, ne pas répondre',

  /**
   * The expiry, with its time zone written out. A key rather than an `Intl`: the
   * instance's time zone is not the recipient's, and a UTC time shown as such is
   * the only one that does not lie. Only the punctuation changes from one
   * language to the other.
   */
  'expiry': '{day}/{month}/{year} à {hours} h {minutes} UTC',
  'validity.days': { one: '{count} jour', other: '{count} jours' },
  'validity.hours': { one: '{count} heure', other: '{count} heures' },
  'validity.minutes': { one: '{count} minute', other: '{count} minutes' },

  // ── Invitation ──────────────────────────────────────────────────────────
  'invitation.subject': 'Votre accès à {instance}',
  'invitation.heading': 'Un accès vous a été ouvert',
  'invitation.body.actor': '{actor} vous a ouvert un accès au plan de contrôle {instance}.',
  'invitation.body.admin':
    'Un administrateur vous a ouvert un accès au plan de contrôle {instance}.',
  /**
   * Saying explicitly that nobody else knows the password is the point of this
   * whole work: it is what changes compared with an account made by an
   * administrator then handed over by hand.
   */
  'invitation.body.secret':
    'Votre compte existe déjà : il ne lui manque qu’un mot de passe. Vous le choisissez vous-même, et personne d’autre ne le connaîtra — pas même l’administrateur qui vous a invité.',
  'invitation.action': 'Choisir mon mot de passe',
  'invitation.ignore':
    'Si vous ne vous attendiez pas à ce message, ignorez-le. Sans ce lien, le compte reste inutilisable.',

  // ── Reset ───────────────────────────────────────────────────────────────
  'reset.subject': 'Réinitialiser votre mot de passe sur {instance}',
  'reset.heading': 'Réinitialisation de votre mot de passe',
  'reset.body.requested':
    'Quelqu’un a demandé la réinitialisation du mot de passe associé à cette adresse sur {instance}.',
  /**
   * Announce the sign-out before it happens: a session that drops without
   * explanation looks like an outage.
   */
  'reset.body.sessions':
    'En choisissant un nouveau mot de passe, vous fermerez toutes les sessions ouvertes sur ce compte, y compris celles que vous n’avez pas ouvertes.',
  'reset.action': 'Choisir un nouveau mot de passe',
  'reset.ignore':
    'Si vous n’avez rien demandé, ignorez ce message : votre mot de passe actuel reste valable et aucune session n’a été fermée.',
} as const;

const en: Translated<typeof fr> = {
  'greeting': 'Hello {name},',
  'link.label': '{action}:',
  'link.validity': 'This link works once. It is valid for {validity} and expires on {expiry}.',
  'link.fallback': 'If the button does not work, copy this address into your browser:',
  'footer': '{instance} · automated message, do not reply',

  'expiry': '{day}/{month}/{year} at {hours}:{minutes} UTC',
  'validity.days': { one: '{count} day', other: '{count} days' },
  'validity.hours': { one: '{count} hour', other: '{count} hours' },
  'validity.minutes': { one: '{count} minute', other: '{count} minutes' },

  'invitation.subject': 'Your access to {instance}',
  'invitation.heading': 'An access has been opened for you',
  'invitation.body.actor': '{actor} opened an access to the {instance} control plane for you.',
  'invitation.body.admin':
    'An administrator opened an access to the {instance} control plane for you.',
  'invitation.body.secret':
    'Your account already exists: all it lacks is a password. You choose it yourself, and nobody else will know it — not even the administrator who invited you.',
  'invitation.action': 'Choose my password',
  'invitation.ignore':
    'If you were not expecting this message, ignore it. Without this link, the account stays unusable.',

  'reset.subject': 'Reset your password on {instance}',
  'reset.heading': 'Password reset',
  'reset.body.requested':
    'Someone asked to reset the password tied to this address on {instance}.',
  'reset.body.sessions':
    'Choosing a new password closes every session open on this account, including the ones you did not open.',
  'reset.action': 'Choose a new password',
  'reset.ignore':
    'If you asked for nothing, ignore this message: your current password stays valid and no session has been closed.',
};

const accountMailMessages = { fr, en };

type MailKey = keyof typeof fr;

/** Binds the dictionary to a language. The same pure function as on the panel side. */
function messageFor(language: UiLanguage) {
  return (key: MailKey, vars?: Vars): string =>
    renderMessage(accountMailMessages, language, key, vars);
}

/**
 * Expiry date, explicit UTC time zone.
 *
 * `Intl` with a named time zone would be nicer, but the instance's time zone is
 * not the recipient's and there is no way to know the latter. A UTC time shown
 * as such is the only one that does not lie. The sentence that goes with it
 * gives the duration anyway, which is the really useful information.
 */
function formatExpiry(iso: string, t: ReturnType<typeof messageFor>): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return t('expiry', {
    day: pad(date.getUTCDate()),
    month: pad(date.getUTCMonth() + 1),
    year: date.getUTCFullYear(),
    hours: pad(date.getUTCHours()),
    minutes: pad(date.getUTCMinutes()),
  });
}

/** Remaining duration, rounded to the unit that reads — "7 days", "1 hour". */
function formatValidity(iso: string, t: ReturnType<typeof messageFor>): string {
  const ms = new Date(iso).getTime() - Date.now();
  const hours = Math.round(ms / 3_600_000);
  if (hours >= 48) return t('validity.days', { count: Math.round(hours / 24) });
  if (hours >= 2) return t('validity.hours', { count: hours });
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes >= 60 ? t('validity.hours', { count: 1 }) : t('validity.minutes', { count: minutes });
}

/** A paragraph of the body: its key and what it expects. */
type Paragraph = { key: MailKey; vars?: Vars };

type Copy = {
  subject: MailKey;
  heading: MailKey;
  /** The body's paragraphs, in order. Plain text: no markup. */
  body: (mail: AccountMail) => Paragraph[];
  action: MailKey;
  /** What to do if you asked for nothing. Never absent — it is the safeguard. */
  ignore: MailKey;
};

/**
 * The structure of both messages, in one place.
 *
 * A data table rather than an `if (kind === …)` spread between the text and
 * HTML renderings: the two parts of one message must say the same thing, and the
 * only way to guarantee it is for them to read the same source. It is the rule
 * applied to the channels' catalog.
 */
const COPY: Record<AccountMailKind, Copy> = {
  invitation: {
    subject: 'invitation.subject',
    heading: 'invitation.heading',
    body: (mail) => {
      // Annotated rather than inferred: without the explicit type, the ternary's two
      // branches merge into a union that promises `actor: undefined`.
      const opener: Paragraph = mail.actor
        ? { key: 'invitation.body.actor', vars: { actor: mail.actor, instance: mail.instance } }
        : { key: 'invitation.body.admin', vars: { instance: mail.instance } };
      return [opener, { key: 'invitation.body.secret' }];
    },
    action: 'invitation.action',
    ignore: 'invitation.ignore',
  },
  password_reset: {
    subject: 'reset.subject',
    heading: 'reset.heading',
    body: (mail) => [
      { key: 'reset.body.requested', vars: { instance: mail.instance } },
      { key: 'reset.body.sessions' },
    ],
    action: 'reset.action',
    ignore: 'reset.ignore',
  },
};

/**
 * Design system tints. Hard-coded, as in `smtp.ts`: an email client reads neither
 * CSS variables nor external sheets.
 */
const C = EMAIL_COLORS;

/**
 * The `text/plain` part.
 *
 * It is not a courtesy fallback: it is what a text-mode client reads, a relay
 * that strips HTML, and a phone notification's preview. The link is in it **in
 * clear and on its own line**, because a link cut by a line break is a dead
 * link.
 */
export function renderAccountMailText(mail: AccountMail, language: UiLanguage): string {
  const t = messageFor(language);
  const copy = COPY[mail.kind];
  const action = t(copy.action);

  const lines = [
    t(copy.heading),
    '',
    t('greeting', { name: mail.recipientName }),
    '',
    ...copy.body(mail).flatMap((paragraph) => [t(paragraph.key, paragraph.vars), '']),
    t('link.label', { action }),
    mail.url,
    '',
    t('link.validity', {
      validity: formatValidity(mail.expiresAt, t),
      expiry: formatExpiry(mail.expiresAt, t),
    }),
    '',
    t(copy.ignore),
    '',
    `— ${mail.instance}`,
  ];

  return lines.join('\n');
}

/**
 * The `text/html` part.
 *
 * Inline styles only, a layout table for the button: it is the only HTML that
 * gets through more or less every client. The link is **also** repeated in
 * clear under the button, because a button that does not render leaves nothing
 * to click.
 */
export function renderAccountMailHtml(mail: AccountMail, language: UiLanguage): string {
  const t = messageFor(language);
  const copy = COPY[mail.kind];
  const url = escapeHtml(mail.url);

  const paragraphs = copy
    .body(mail)
    .map(
      (paragraph) =>
        `<p style="margin:0 0 12px;font-size:14px;line-height:1.55;color:${C.text2}">${escapeHtml(t(paragraph.key, paragraph.vars))}</p>`,
    )
    .join('');

  return [
    `<!doctype html><html lang="${language}"><body style="margin:0;background:${C.bg};padding:24px;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:${C.text}">`,
    `<div style="max-width:560px;margin:0 auto;background:${C.surface};border-radius:12px;border:1px solid ${C.border};padding:24px">`,
    brandHeaderHtml(mail.instance),
    `<h1 style="margin:0 0 12px;font-size:18px;line-height:1.3">${escapeHtml(t(copy.heading))}</h1>`,
    `<p style="margin:0 0 12px;font-size:14px;line-height:1.55;color:${C.text2}">${escapeHtml(t('greeting', { name: mail.recipientName }))}</p>`,
    paragraphs,
    `<table role="presentation" style="margin:20px 0 0;border-collapse:collapse"><tr><td style="border-radius:8px;background:${C.accent}">`,
    `<a href="${url}" style="display:inline-block;padding:11px 20px;font-size:14px;font-weight:600;color:#FFFFFF;text-decoration:none">${escapeHtml(t(copy.action))}</a>`,
    '</td></tr></table>',
    `<p style="margin:14px 0 0;font-size:12px;line-height:1.5;color:${C.text3}">${escapeHtml(t('link.fallback'))}<br>`,
    `<a href="${url}" style="color:${C.accentText};font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all">${url}</a></p>`,
    `<p style="margin:16px 0 0;font-size:13px;line-height:1.5;color:${C.text2}">${escapeHtml(
      t('link.validity', {
        validity: formatValidity(mail.expiresAt, t),
        expiry: formatExpiry(mail.expiresAt, t),
      }),
    )}</p>`,
    `<p style="margin:12px 0 0;font-size:13px;line-height:1.5;color:${C.text3}">${escapeHtml(t(copy.ignore))}</p>`,
    `<p style="margin:22px 0 0;padding-top:14px;border-top:1px solid ${C.border};font-size:12px;color:${C.text3}">${escapeHtml(t('footer', { instance: mail.instance }))}</p>`,
    '</div></body></html>',
  ].join('');
}

/**
 * The complete envelope: subject, text, HTML.
 *
 * The subject does **not** carry the alerts' `[instance]` prefix. An alert is
 * sorted in an on-call inbox that receives some from several panels; this one
 * arrives at a person who expects precisely this message, and a bracket at the
 * start looks like machine mail — hence like spam.
 */
export function renderAccountMail(mail: AccountMail, language: UiLanguage): AccountMailEnvelope {
  return {
    subject: messageFor(language)(COPY[mail.kind].subject, { instance: mail.instance }),
    text: renderAccountMailText(mail, language),
    html: renderAccountMailHtml(mail, language),
    inlineImages: [BRAND_MARK],
  };
}
