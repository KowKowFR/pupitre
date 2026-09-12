import { z } from 'zod';

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
 * Date d'expiration en français, fuseau UTC explicite.
 *
 * `Intl` avec un fuseau nommé serait plus agréable, mais le fuseau de
 * l'instance n'est pas celui du destinataire et il n'existe aucun moyen de
 * connaître le second. Une heure UTC affichée comme telle est la seule qui ne
 * ment pas. La phrase qui l'accompagne donne de toute façon la durée, qui est
 * l'information réellement utile.
 */
function formatExpiry(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${pad(date.getUTCDate())}/${pad(date.getUTCMonth() + 1)}/${date.getUTCFullYear()} ` +
    `à ${pad(date.getUTCHours())} h ${pad(date.getUTCMinutes())} UTC`
  );
}

/** Durée restante, arrondie à l'unité qui se lit — « 7 jours », « 1 heure ». */
function formatValidity(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  const hours = Math.round(ms / 3_600_000);
  if (hours >= 48) return `${Math.round(hours / 24)} jours`;
  if (hours >= 2) return `${hours} heures`;
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes >= 60 ? '1 heure' : `${minutes} minutes`;
}

type Copy = {
  subject: (mail: AccountMail) => string;
  heading: string;
  /** Paragraphes du corps, dans l'ordre. Du texte simple : aucun balisage. */
  body: (mail: AccountMail) => string[];
  action: string;
  /** Ce qu'il faut faire si on n'a rien demandé. Jamais absent — c'est la garde. */
  ignore: string;
};

/**
 * Le texte des deux messages, en un seul endroit.
 *
 * Une table de données plutôt qu'un `if (kind === …)` réparti entre le rendu
 * texte et le rendu HTML : les deux parties d'un même message doivent dire la
 * même chose, et la seule façon de le garantir est qu'elles lisent la même
 * source. C'est la règle appliquée au catalogue des canaux.
 */
const COPY: Record<AccountMailKind, Copy> = {
  invitation: {
    subject: (mail) => `Votre accès à ${mail.instance}`,
    heading: 'Un accès vous a été ouvert',
    body: (mail) => [
      mail.actor
        ? `${mail.actor} vous a ouvert un accès au plan de contrôle ${mail.instance}.`
        : `Un administrateur vous a ouvert un accès au plan de contrôle ${mail.instance}.`,
      // Dire explicitement que personne d'autre ne connaît le mot de passe est
      // le point de tout ce chantier : c'est ce qui change par rapport à un
      // compte fabriqué par un administrateur puis transmis de la main à la main.
      'Votre compte existe déjà : il ne lui manque qu’un mot de passe. ' +
        'Vous le choisissez vous-même, et personne d’autre ne le connaîtra — ' +
        'pas même l’administrateur qui vous a invité.',
    ],
    action: 'Choisir mon mot de passe',
    ignore:
      'Si vous ne vous attendiez pas à ce message, ignorez-le. ' +
      'Sans ce lien, le compte reste inutilisable.',
  },
  password_reset: {
    subject: (mail) => `Réinitialiser votre mot de passe sur ${mail.instance}`,
    heading: 'Réinitialisation de votre mot de passe',
    body: (mail) => [
      `Quelqu’un a demandé la réinitialisation du mot de passe associé à cette adresse sur ${mail.instance}.`,
      // Annoncer la déconnexion avant qu'elle n'arrive : une session qui tombe
      // sans explication ressemble à une panne.
      'En choisissant un nouveau mot de passe, vous fermerez toutes les sessions ' +
        'ouvertes sur ce compte, y compris celles que vous n’avez pas ouvertes.',
    ],
    action: 'Choisir un nouveau mot de passe',
    ignore:
      'Si vous n’avez rien demandé, ignorez ce message : votre mot de passe actuel ' +
      'reste valable et aucune session n’a été fermée.',
  },
};

/** Teinte de l'encadré. En dur, comme dans `smtp.ts` : un client d'e-mail ne lit ni variable CSS ni feuille externe. */
const ACCENT = '#3b6fd4';

/**
 * La partie `text/plain`.
 *
 * Elle n'est pas un repli de politesse : c'est elle que lisent un client en
 * mode texte, un relais qui déshabille le HTML, et l'aperçu d'une notification
 * de téléphone. Le lien y figure **en clair et sur sa propre ligne**, parce
 * qu'un lien coupé par un retour à la ligne est un lien mort.
 */
export function renderAccountMailText(mail: AccountMail): string {
  const copy = COPY[mail.kind];

  const lines = [
    copy.heading,
    '',
    `Bonjour ${mail.recipientName},`,
    '',
    ...copy.body(mail).flatMap((paragraph) => [paragraph, '']),
    `${copy.action} :`,
    mail.url,
    '',
    `Ce lien ne fonctionne qu’une seule fois. Il est valable ${formatValidity(mail.expiresAt)} ` +
      `et expire le ${formatExpiry(mail.expiresAt)}.`,
    '',
    copy.ignore,
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
export function renderAccountMailHtml(mail: AccountMail): string {
  const copy = COPY[mail.kind];
  const url = escapeHtml(mail.url);

  const paragraphs = copy
    .body(mail)
    .map(
      (paragraph) =>
        `<p style="margin:0 0 12px;font-size:14px;line-height:1.55;color:#374151">${escapeHtml(paragraph)}</p>`,
    )
    .join('');

  return [
    '<!doctype html><html lang="fr"><body style="margin:0;background:#f5f6f8;padding:24px;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#111827">',
    `<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;border:1px solid #e5e7eb;border-left:4px solid ${ACCENT};padding:20px 24px">`,
    `<div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:${ACCENT};font-weight:600">${escapeHtml(mail.instance)}</div>`,
    `<h1 style="margin:6px 0 12px;font-size:18px;line-height:1.3">${escapeHtml(copy.heading)}</h1>`,
    `<p style="margin:0 0 12px;font-size:14px;line-height:1.55;color:#374151">Bonjour ${escapeHtml(mail.recipientName)},</p>`,
    paragraphs,
    `<table role="presentation" style="margin:20px 0 0;border-collapse:collapse"><tr><td style="border-radius:6px;background:${ACCENT}">`,
    `<a href="${url}" style="display:inline-block;padding:11px 20px;font-size:14px;font-weight:600;color:#fff;text-decoration:none">${escapeHtml(copy.action)}</a>`,
    '</td></tr></table>',
    `<p style="margin:14px 0 0;font-size:12px;line-height:1.5;color:#6b7280">Si le bouton ne fonctionne pas, copiez cette adresse dans votre navigateur :<br>`,
    `<a href="${url}" style="color:${ACCENT};font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all">${url}</a></p>`,
    `<p style="margin:16px 0 0;font-size:13px;line-height:1.5;color:#374151">Ce lien ne fonctionne qu’une seule fois. Il est valable ${escapeHtml(formatValidity(mail.expiresAt))} et expire le ${escapeHtml(formatExpiry(mail.expiresAt))}.</p>`,
    `<p style="margin:12px 0 0;font-size:13px;line-height:1.5;color:#6b7280">${escapeHtml(copy.ignore)}</p>`,
    `<p style="margin:22px 0 0;padding-top:14px;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af">${escapeHtml(mail.instance)} · message automatique, ne pas répondre</p>`,
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
export function renderAccountMail(mail: AccountMail): AccountMailEnvelope {
  return {
    subject: COPY[mail.kind].subject(mail),
    text: renderAccountMailText(mail),
    html: renderAccountMailHtml(mail),
  };
}
