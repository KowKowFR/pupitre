import {
  accountMailJobDataSchema,
  accountMailSchema,
  decrypt,
  describeFailure,
  languageOf,
  renderAccountMail,
  type AccountMailJobResult,
} from '@pupitre/core';
import {
  NOTIFICATION_TIMEOUT_MS,
  nodemailerTransport,
  smtpOptionsFrom,
  smtpSenderFrom,
} from '@pupitre/core/notifications';
import {
  getAppSettingsValue,
  listNotificationChannels,
  logAudit,
  resolveNotificationChannel,
  type NotificationChannelRecord,
} from '@pupitre/db';
import { UnrecoverableError, type Job } from 'bullmq';
import { instanceLanguage } from '../language.js';
import { logger } from '../logger.js';
import { workerSay } from '../messages.js';

/**
 * Les e-mails transactionnels du cycle de vie des comptes : invitation et
 * réinitialisation de mot de passe.
 *
 * ── Pourquoi ici et pas dans le panel ───────────────────────────────────────
 * Le panel n'a aucun transport SMTP — `nodemailer` est tenu hors de son graphe
 * exactement comme `ssh2`, et `verify-server-supervision.sh` va jusqu'à
 * chercher `ssh2` dans son bundle pour le prouver. Il enfile, le worker
 * délivre. C'est le même chemin que l'essai d'un canal.
 *
 * ── Pourquoi ce n'est pas une notification ──────────────────────────────────
 * Une notification part vers les destinataires **configurés** d'un canal ; cet
 * e-mail part vers la personne désignée par l'action. On emprunte donc au canal
 * SMTP son transport (serveur, port, chiffrement, identifiants, expéditeur) et
 * rien d'autre — pas son champ « Destinataires », pas ses abonnements
 * d'événements, pas sa mise en forme d'alerte.
 */

/**
 * Le canal SMTP dont on emprunte le transport.
 *
 * Règle : le premier canal SMTP **actif** dans l'ordre alphabétique de son nom
 * — c'est-à-dire l'ordre dans lequel l'écran des paramètres les affiche, donc
 * un choix qu'un opérateur peut prédire sans lire ce fichier. Une instance qui
 * en configure deux a déjà décidé que les deux savent poster ; celle qui n'en
 * configure aucun ne peut pas inviter, et l'écran le dit avant de proposer le
 * parcours.
 *
 * Volontairement pas un drapeau « canal transactionnel » en base : ce serait
 * une colonne, une migration, une case à cocher de plus dans un écran, et une
 * quatrième façon de se tromper — pour un arbitrage que 99 % des instances ne
 * rencontreront jamais.
 */
function pickTransactionalMailChannel(
  channels: NotificationChannelRecord[],
): NotificationChannelRecord | null {
  return (
    channels.find(
      (channel) =>
        channel.kind === 'smtp' &&
        channel.enabled &&
        typeof channel.config.host === 'string' &&
        channel.config.host.trim().length > 0,
    ) ?? null
  );
}

export async function handleAccountMail(
  job: Job<unknown, AccountMailJobResult>,
): Promise<AccountMailJobResult> {
  const data = accountMailJobDataSchema.parse(job.data);
  const log = logger.child({ jobId: job.id, kind: data.kind, userId: data.userId });

  const channels = await listNotificationChannels();
  const picked = pickTransactionalMailChannel(channels);

  if (!picked) {
    /**
     * Aucun canal SMTP : le message ne partira pas, et rien ne le fera partir
     * plus tard. `UnrecoverableError` plutôt qu'un échec ordinaire — un rejeu
     * ne configurerait pas de serveur d'e-mail.
     *
     * Le panel refuse déjà d'ouvrir le parcours dans ce cas ; on arrive ici
     * quand le canal a été supprimé entre le formulaire et la consommation.
     */
    await logAudit({
      actorId: null,
      action: 'account.mail.undeliverable',
      resourceType: 'user',
      resourceId: data.userId,
      after: { kind: data.kind, reason: 'no_smtp_channel' },
    });
    log.error('aucun canal SMTP actif : e-mail de compte non délivrable');
    throw new UnrecoverableError(workerSay(await instanceLanguage())('mail.noSmtp'));
  }

  const resolved = await resolveNotificationChannel(picked.id);
  if (!resolved) throw new UnrecoverableError(`canal « ${picked.name} » disparu`);

  const settings = await getAppSettingsValue();

  /**
   * Le lien n'existe en clair qu'ici, dans la mémoire du worker, le temps du
   * rendu. Il ne redescend ni en base, ni dans l'audit, ni dans les logs — le
   * `log.child` plus haut ne porte que le type et l'identifiant du compte.
   */
  const mail = accountMailSchema.parse({
    kind: data.kind,
    to: data.to,
    recipientName: data.recipientName,
    instance: settings.instanceName,
    url: decrypt(data.encryptedUrl),
    expiresAt: data.expiresAt,
    actor: data.actor,
  });

  /**
   * La langue de l'e-mail est celle de **l'instance**, pas du destinataire :
   * une invitation part vers quelqu'un qui n'a pas encore de compte, donc
   * personne à qui demander. Même règle que les alertes et que le panel, et
   * même source — la locale de régionalisation.
   */
  const envelope = renderAccountMail(mail, languageOf(settings.locale));
  const transport = nodemailerTransport(smtpOptionsFrom(resolved.resolved, NOTIFICATION_TIMEOUT_MS));

  try {
    await transport.send({
      from: smtpSenderFrom(resolved.resolved),
      // Un seul destinataire, toujours : celui du compte. Le champ
      // « Destinataires » du canal ne s'applique qu'à ses alertes.
      to: [mail.to],
      subject: envelope.subject,
      text: envelope.text,
      html: envelope.html,
      inlineImages: envelope.inlineImages,
      headers: {
        // Le type, pas le contenu : il permet un filtre côté client d'e-mail et
        // il ne dit rien qui ne soit déjà dans le sujet.
        'X-Control-Plane-Account-Mail': mail.kind,
        // RFC 3834 : ce message ne doit déclencher ni réponse automatique, ni
        // message d'absence — la personne n'a personne à qui répondre ici.
        'Auto-Submitted': 'auto-generated',
      },
    });
  } catch (error) {
    const detail = describeFailure(error, resolved.resolved.secrets, await instanceLanguage());
    await logAudit({
      actorId: null,
      action: 'account.mail.failed',
      resourceType: 'user',
      resourceId: data.userId,
      after: { kind: data.kind, channel: picked.name, error: detail },
    });
    log.error({ error: detail }, 'e-mail de compte non délivré');
    return { kind: data.kind, delivered: false, channel: picked.name, error: detail };
  } finally {
    transport.close();
  }

  /**
   * Aucun appel à `recordNotificationOutcome()`.
   *
   * Ces compteurs répondent à « depuis quand ce canal n'alerte plus ? ». Un
   * refus de destinataire (550 sur une adresse fausse) n'apprend rien là-dessus
   * et ferait apparaître en rouge, sur l'écran des paramètres, un canal dont les
   * alertes fonctionnent parfaitement.
   */
  await logAudit({
    actorId: null,
    action: 'account.mail.sent',
    resourceType: 'user',
    resourceId: data.userId,
    // Ni jeton, ni lien : seulement l'adresse, qui est déjà dans `users.email`,
    // et la date limite, qui n'ouvre rien.
    after: { kind: data.kind, to: mail.to, channel: picked.name, expiresAt: mail.expiresAt },
  });

  log.info({ channel: picked.name }, 'e-mail de compte délivré');
  return { kind: data.kind, delivered: true, channel: picked.name, error: null };
}
