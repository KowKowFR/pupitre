import { z } from 'zod';
import {
  renderMessage,
  type Translated,
  type UiLanguage,
  type Vars,
} from '../i18n.js';
import { BRAND_MARK, EMAIL_COLORS, brandHeaderHtml, type InlineImage } from './brand.js';

/**
 * Les e-mails **transactionnels** du cycle de vie des comptes.
 *
 * Ils ne sont pas des notifications, et la distinction n'est pas de vocabulaire :
 *
 *   — une notification part vers les **destinataires configurés** d'un canal
 *     (la boîte d'astreinte), décrit un fait déjà arrivé, et si elle se perd on
 *     s'en aperçoit plus tard ;
 *   — un e-mail transactionnel part vers **une personne précise**, désignée par
 *     l'action en cours, et il porte le seul moyen de terminer cette action.
 *     S'il se perd, la personne est bloquée.
 *
 * D'où un module séparé, un rendu séparé, et surtout un destinataire qui ne
 * vient pas du canal mais de l'appelant. Ce qu'on emprunte au canal SMTP, c'est
 * uniquement son **transport** : serveur, port, chiffrement, identifiants,
 * adresse d'expéditeur. Voir `smtpOptionsFrom()` dans `./smtp.ts`.
 *
 * Ce module ne dépend que de Zod — pas de `nodemailer` : il est réexporté depuis
 * la racine de `@pupitre/core`, donc lisible par le panel Next et par le schéma
 * de la file, sans tirer de transport dans leur graphe.
 */

export const ACCOUNT_MAIL_KINDS = ['invitation', 'password_reset'] as const;

export const accountMailKindSchema = z.enum(ACCOUNT_MAIL_KINDS);
export type AccountMailKind = z.infer<typeof accountMailKindSchema>;

/**
 * Ce qu'un e-mail transactionnel transporte.
 *
 * `url` est un **lien porteur** : quiconque l'ouvre prend la main sur le compte.
 * Il n'a donc rien à faire dans un journal, dans une réponse d'API ni dans une
 * charge de tâche en clair — la file le transporte chiffré, voir
 * `accountMailJobDataSchema` dans `../queue.js`.
 */
export const accountMailSchema = z.object({
  kind: accountMailKindSchema,
  /** Adresse du destinataire. Une seule : ces messages n'ont jamais de copie. */
  to: z.string().trim().min(3).max(200),
  /** Nom affiché dans la salutation. Le compte en a toujours un. */
  recipientName: z.string().trim().min(1).max(120),
  /** Nom de l'instance émettrice, comme pour les notifications. */
  instance: z.string().trim().min(1).max(60),
  url: z.string().url().max(2000),
  expiresAt: z.string().datetime(),
  /**
   * Qui a déclenché l'envoi, quand quelqu'un l'a déclenché. Une invitation vient
   * d'un administrateur et le dire rassure ; une réinitialisation vient de la
   * personne elle-même (ou de quelqu'un qui a tapé son adresse) et n'a pas
   * d'acteur à nommer.
   */
  actor: z.string().trim().min(1).max(200).nullable().default(null),
});

export type AccountMail = z.infer<typeof accountMailSchema>;

/** Ce qu'un canal SMTP a besoin de savoir pour poster le message. */
export type AccountMailEnvelope = {
  subject: string;
  text: string;
  html: string;
  /** À joindre tel quel à l'envoi : le HTML y fait référence par `cid:`. */
  inlineImages: InlineImage[];
};

/** Échappement HTML. Le nom du destinataire vient d'un formulaire : rien n'est sûr. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Le texte des deux messages, en un seul endroit — et sa traduction juste à
 * côté.
 *
 * ── Pourquoi le dictionnaire vit ici et pas dans `apps/web` ─────────────────
 * Ce n'est pas le panel qui compose ces e-mails : c'est le worker, qui a le
 * transport SMTP et le seul accès au lien en clair. Un dictionnaire rangé dans
 * `apps/web/src/i18n/messages` lui serait donc inaccessible. Il vit là où vit
 * la composition, comme le veut la règle : les dictionnaires de l'interface
 * chez l'interface, ceux du domaine à côté du domaine.
 *
 * ── Pourquoi la langue est un paramètre ─────────────────────────────────────
 * Une invitation part vers quelqu'un qui n'a pas encore de session : il n'y a
 * personne à qui demander sa langue. C'est donc celle de l'instance, comme les
 * alertes et comme le panel — et elle est **passée** plutôt que lue ici, parce
 * que ce module ne dépend que de Zod et n'a aucun accès à la base.
 */
const fr = {
  // ── Le cadre, commun aux deux messages ──────────────────────────────────
  'greeting': 'Bonjour {name},',
  'link.label': '{action} :',
  'link.validity':
    'Ce lien ne fonctionne qu’une seule fois. Il est valable {validity} et expire le {expiry}.',
  'link.fallback': 'Si le bouton ne fonctionne pas, copiez cette adresse dans votre navigateur :',
  'footer': '{instance} · message automatique, ne pas répondre',

  /**
   * L'échéance, avec son fuseau écrit. Une clé plutôt qu'un `Intl` : le fuseau
   * de l'instance n'est pas celui du destinataire, et une heure UTC affichée
   * comme telle est la seule qui ne mente pas. Seule la ponctuation change
   * d'une langue à l'autre.
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
   * Dire explicitement que personne d'autre ne connaît le mot de passe est le
   * point de tout ce chantier : c'est ce qui change par rapport à un compte
   * fabriqué par un administrateur puis transmis de la main à la main.
   */
  'invitation.body.secret':
    'Votre compte existe déjà : il ne lui manque qu’un mot de passe. Vous le choisissez vous-même, et personne d’autre ne le connaîtra — pas même l’administrateur qui vous a invité.',
  'invitation.action': 'Choisir mon mot de passe',
  'invitation.ignore':
    'Si vous ne vous attendiez pas à ce message, ignorez-le. Sans ce lien, le compte reste inutilisable.',

  // ── Réinitialisation ────────────────────────────────────────────────────
  'reset.subject': 'Réinitialiser votre mot de passe sur {instance}',
  'reset.heading': 'Réinitialisation de votre mot de passe',
  'reset.body.requested':
    'Quelqu’un a demandé la réinitialisation du mot de passe associé à cette adresse sur {instance}.',
  /**
   * Annoncer la déconnexion avant qu'elle n'arrive : une session qui tombe sans
   * explication ressemble à une panne.
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

/** Lie le dictionnaire à une langue. Même fonction pure que côté panel. */
function messageFor(language: UiLanguage) {
  return (key: MailKey, vars?: Vars): string =>
    renderMessage(accountMailMessages, language, key, vars);
}

/**
 * Date d'expiration, fuseau UTC explicite.
 *
 * `Intl` avec un fuseau nommé serait plus agréable, mais le fuseau de
 * l'instance n'est pas celui du destinataire et il n'existe aucun moyen de
 * connaître le second. Une heure UTC affichée comme telle est la seule qui ne
 * ment pas. La phrase qui l'accompagne donne de toute façon la durée, qui est
 * l'information réellement utile.
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

/** Durée restante, arrondie à l'unité qui se lit — « 7 jours », « 1 heure ». */
function formatValidity(iso: string, t: ReturnType<typeof messageFor>): string {
  const ms = new Date(iso).getTime() - Date.now();
  const hours = Math.round(ms / 3_600_000);
  if (hours >= 48) return t('validity.days', { count: Math.round(hours / 24) });
  if (hours >= 2) return t('validity.hours', { count: hours });
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes >= 60 ? t('validity.hours', { count: 1 }) : t('validity.minutes', { count: minutes });
}

/** Un paragraphe du corps : sa clé et ce qu'elle attend. */
type Paragraph = { key: MailKey; vars?: Vars };

type Copy = {
  subject: MailKey;
  heading: MailKey;
  /** Paragraphes du corps, dans l'ordre. Du texte simple : aucun balisage. */
  body: (mail: AccountMail) => Paragraph[];
  action: MailKey;
  /** Ce qu'il faut faire si on n'a rien demandé. Jamais absent — c'est la garde. */
  ignore: MailKey;
};

/**
 * La structure des deux messages, en un seul endroit.
 *
 * Une table de données plutôt qu'un `if (kind === …)` réparti entre le rendu
 * texte et le rendu HTML : les deux parties d'un même message doivent dire la
 * même chose, et la seule façon de le garantir est qu'elles lisent la même
 * source. C'est la règle appliquée au catalogue des canaux.
 */
const COPY: Record<AccountMailKind, Copy> = {
  invitation: {
    subject: 'invitation.subject',
    heading: 'invitation.heading',
    body: (mail) => {
      // Annoté plutôt qu'inféré : sans le type explicite, les deux branches du
      // ternaire fusionnent en une union qui promet `actor: undefined`.
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

/** Teintes du design system. En dur, comme dans `smtp.ts` : un client d'e-mail ne lit ni variable CSS ni feuille externe. */
const C = EMAIL_COLORS;

/**
 * La partie `text/plain`.
 *
 * Elle n'est pas un repli de politesse : c'est elle que lisent un client en
 * mode texte, un relais qui déshabille le HTML, et l'aperçu d'une notification
 * de téléphone. Le lien y figure **en clair et sur sa propre ligne**, parce
 * qu'un lien coupé par un retour à la ligne est un lien mort.
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
 * La partie `text/html`.
 *
 * Style en ligne uniquement, table de mise en page pour le bouton : c'est le
 * seul HTML qui traverse à peu près tous les clients. Le lien est **aussi**
 * répété en clair sous le bouton, parce qu'un bouton qui ne se rend pas ne
 * laisse rien à cliquer.
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
 * L'enveloppe complète : sujet, texte, HTML.
 *
 * Le sujet ne porte **pas** le préfixe `[instance]` des alertes. Une alerte est
 * triée dans une boîte d'astreinte qui en reçoit de plusieurs panels ; celui-ci
 * arrive chez une personne qui attend précisément ce message, et un crochet en
 * tête ressemble à du courrier de machine — donc à du spam.
 */
export function renderAccountMail(mail: AccountMail, language: UiLanguage): AccountMailEnvelope {
  return {
    subject: messageFor(language)(COPY[mail.kind].subject, { instance: mail.instance }),
    text: renderAccountMailText(mail, language),
    html: renderAccountMailHtml(mail, language),
    inlineImages: [BRAND_MARK],
  };
}
