import { z } from 'zod';

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
 * Ce module ne dépend que de Zod : il est réexporté depuis la racine de
 * `@tp/core`, donc lisible par le panel Next sans tirer `nodemailer` dans son
 * graphe. Les implémentations, elles, vivent sous `@tp/core/notifications`.
 */

export const NOTIFICATION_SEVERITIES = ['info', 'warning', 'critical'] as const;

export const notificationSeveritySchema = z.enum(NOTIFICATION_SEVERITIES);
export type NotificationSeverity = z.infer<typeof notificationSeveritySchema>;

export const NOTIFICATION_SEVERITY_LABELS: Record<NotificationSeverity, string> = {
  info: 'Information',
  warning: 'Avertissement',
  critical: 'Critique',
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
    `— ${message.instance} · ${NOTIFICATION_SEVERITY_LABELS[message.severity].toLowerCase()} · ${message.occurredAt}`,
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
}): NotificationMessage {
  return notificationMessageSchema.parse({
    event: 'notification.test',
    severity: 'info',
    title: `Message d'essai — ${options.channelName}`,
    body:
      "Si vous lisez ceci, le canal est correctement configuré : le panel sait joindre " +
      'ce destinataire. Aucun incident ne s’est produit, personne n’a rien à faire.',
    fields: [
      { label: 'Canal', value: options.channelName },
      { label: 'Instance', value: options.instance },
    ],
    url: options.panelUrl ? `${options.panelUrl.replace(/\/+$/, '')}/admin/settings/notifications` : null,
    instance: options.instance,
    occurredAt: new Date().toISOString(),
  });
}
