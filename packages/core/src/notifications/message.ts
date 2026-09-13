import { z } from 'zod';
import {
  DEFAULT_UI_LANGUAGE,
  UI_LANGUAGES,
  renderMessage,
  type Translated,
  type UiLanguage,
  type Vars,
} from '../i18n.js';

/**
 * Le message neutre — tout ce qu'un canal reçoit, et rien de plus.
 *
 * Un canal ne reçoit **ni** HTML d'e-mail, **ni** Markdown Telegram, **ni**
 * `embed` Discord : il reçoit un titre, un corps, une gravité, quelques champs
 * et un lien. C'est chaque implémentation qui sait rendre cela dans son
 * protocole — l'e-mail en texte *et* en HTML, Discord en `embed` coloré,
 * Telegram en `MarkdownV2` avec ses échappements, le webhook en JSON brut.
 *
 * La règle qui tient l'abstraction : si le code appelant se met à écrire du
 * HTML ou des astérisques, l'abstraction fuit et il faut corriger ici, pas
 * là-bas.
 *
 * Ce module ne dépend que de Zod et du mécanisme de traduction — deux modules
 * sans dépendance : il est réexporté depuis la racine de `@pupitre/core`, donc
 * lisible par le panel Next sans tirer `nodemailer` dans son graphe. Les
 * implémentations, elles, vivent sous `@pupitre/core/notifications`.
 */

export const NOTIFICATION_SEVERITIES = ['info', 'warning', 'critical'] as const;

export const notificationSeveritySchema = z.enum(NOTIFICATION_SEVERITIES);
export type NotificationSeverity = z.infer<typeof notificationSeveritySchema>;

/**
 * Les mots que **tout** canal ajoute autour du message neutre : la gravité en
 * toutes lettres, le lien vers le panel, le message d'essai. Ils vivent ici
 * parce que quatre protocoles les rendent différemment mais les disent pareil.
 */
const fr = {
  'severity.info': 'Information',
  'severity.warning': 'Avertissement',
  'severity.critical': 'Critique',
  'openInPanel': 'Ouvrir dans le panel',
  'test.title': "Message d'essai — {channel}",
  'test.body':
    "Si vous lisez ceci, le canal est correctement configuré : le panel sait joindre " +
    'ce destinataire. Aucun incident ne s’est produit, personne n’a rien à faire.',
  'test.field.channel': 'Canal',
  'test.field.instance': 'Instance',
} as const;

const en: Translated<typeof fr> = {
  'severity.info': 'Information',
  'severity.warning': 'Warning',
  'severity.critical': 'Critical',
  'openInPanel': 'Open in the panel',
  'test.title': 'Test message — {channel}',
  'test.body':
    'If you are reading this, the channel is set up correctly: the panel can reach this ' +
    'recipient. Nothing happened, nobody has anything to do.',
  'test.field.channel': 'Channel',
  'test.field.instance': 'Instance',
};

const MESSAGE_TEXT = { fr, en };

function t(language: UiLanguage, key: keyof typeof fr, vars?: Vars): string {
  return renderMessage(MESSAGE_TEXT, language, key, vars);
}

/** La gravité en toutes lettres, dans la langue de l'instance. */
export function notificationSeverityLabel(
  severity: NotificationSeverity,
  language: UiLanguage = DEFAULT_UI_LANGUAGE,
): string {
  return t(language, `severity.${severity}`);
}

/** Le libellé du lien vers le panel — un canal ne l'écrit jamais lui-même. */
export function notificationOpenLabel(language: UiLanguage = DEFAULT_UI_LANGUAGE): string {
  return t(language, 'openInPanel');
}

/**
 * La table française, conservée pour les appelants qui ne portent pas encore de
 * langue. `notificationSeverityLabel()` est ce qu'il faut appeler.
 */
export const NOTIFICATION_SEVERITY_LABELS: Record<NotificationSeverity, string> = {
  info: fr['severity.info'],
  warning: fr['severity.warning'],
  critical: fr['severity.critical'],
};

/**
 * Une paire étiquette / valeur. Volontairement des chaînes : le canal n'a pas à
 * deviner comment rendre un nombre, une date ou un booléen, et deux canaux ne
 * les rendraient pas pareil. La mise en forme appartient à celui qui compose le
 * message, une fois, pour tout le monde.
 */
export const notificationFieldSchema = z.object({
  label: z.string().trim().min(1).max(60),
  value: z.string().trim().min(1).max(500),
});

export type NotificationField = z.infer<typeof notificationFieldSchema>;

export const notificationMessageSchema = z.object({
  /** Clé de l'événement à l'origine du message — jamais un libellé traduit. */
  event: z.string().min(1).max(80),
  severity: notificationSeveritySchema,
  title: z.string().trim().min(1).max(200),
  /** Deux ou trois phrases. Du texte simple : aucune syntaxe de balisage. */
  body: z.string().trim().min(1).max(2000),
  fields: z.array(notificationFieldSchema).max(12).default([]),
  /** Lien absolu vers l'écran du panel qui montre l'objet. `null` s'il n'y en a pas. */
  url: z.string().url().max(500).nullable().default(null),
  /**
   * Nom de l'instance émettrice. Deux panels qui écrivent dans le même salon
   * Discord sont indiscernables sans lui — et c'est un cas courant.
   */
  instance: z.string().trim().min(1).max(60),
  occurredAt: z.string().datetime(),
  /**
   * Langue dans laquelle le message a été composé.
   *
   * Elle voyage avec lui parce que le canal écrit ses propres mots par-dessus —
   * la gravité en toutes lettres, « Ouvrir dans le panel » — et qu'il le fait
   * plus tard, dans une autre tâche, sans accès aux paramètres. Un défaut
   * plutôt qu'un champ obligatoire : une tâche déjà enfilée avant ce champ doit
   * continuer à se déserialiser, sinon l'alerte est perdue.
   */
  language: z.enum(UI_LANGUAGES).default(DEFAULT_UI_LANGUAGE),
});

export type NotificationMessage = z.infer<typeof notificationMessageSchema>;

/**
 * Rendu en texte brut, commun à tous les canaux qui en ont besoin (la partie
 * `text/plain` d'un e-mail, le repli d'un canal qui refuse le balisage).
 *
 * Il vit ici et non dans chaque implémentation parce que c'est le rendu *du
 * message neutre lui-même*, sans protocole : le dupliquer trois fois ferait
 * diverger trois versions de la même chose.
 */
export function renderPlainText(message: NotificationMessage): string {
  const lines = [message.title, '', message.body];

  if (message.fields.length > 0) {
    lines.push('');
    for (const field of message.fields) lines.push(`${field.label} : ${field.value}`);
  }

  if (message.url) {
    lines.push('', message.url);
  }

  lines.push(
    '',
    `— ${message.instance} · ${notificationSeverityLabel(message.severity, message.language).toLowerCase()} · ${message.occurredAt}`,
  );

  return lines.join('\n');
}

/**
 * Message d'essai. Il porte une vraie gravité et de vrais champs : un essai qui
 * n'exercerait pas le rendu complet ne prouverait pas grand-chose du canal.
 */
export function testNotificationMessage(options: {
  instance: string;
  panelUrl: string | null;
  channelName: string;
  /** Langue de l'instance. Le panel la résout avant d'enfiler l'essai. */
  language?: UiLanguage;
}): NotificationMessage {
  const language = options.language ?? DEFAULT_UI_LANGUAGE;

  return notificationMessageSchema.parse({
    event: 'notification.test',
    severity: 'info',
    title: t(language, 'test.title', { channel: options.channelName }),
    body: t(language, 'test.body'),
    fields: [
      // Le **nom** du canal est de la donnée : l'opérateur l'a écrit, on le
      // recopie tel quel. Seule son étiquette se traduit.
      { label: t(language, 'test.field.channel'), value: options.channelName },
      { label: t(language, 'test.field.instance'), value: options.instance },
    ],
    url: options.panelUrl ? `${options.panelUrl.replace(/\/+$/, '')}/admin/settings/notifications` : null,
    instance: options.instance,
    occurredAt: new Date().toISOString(),
    language,
  });
}
