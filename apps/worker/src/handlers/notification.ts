import {
  NOTIFICATIONS_QUEUE,
  NOTIFICATION_DISPATCH_JOB,
  auditNotificationObserver,
  buildNotificationMessage,
  describeFailure,
  isNotificationEventKey,
  notificationDispatchJobDataSchema,
  notificationTestJobDataSchema,
  testNotificationMessage,
  type NotificationDispatchJobResult,
  type NotificationTestJobResult,
} from '@tp/core';
import { getNotificationChannel } from '@tp/core/notifications';
import {
  getAppSettingsValue,
  logAudit,
  notificationActorLabel,
  notificationChannelsForEvent,
  recordNotificationOutcome,
  resolveNotificationChannel,
  setAuditObserver,
} from '@tp/db';
import { Queue, type Job } from 'bullmq';
import { logger } from '../logger.js';
import { createRedisConnection } from '../redis.js';

/**
 * Envoi des notifications.
 *
 * ── Pourquoi la file ────────────────────────────────────────────────────────
 * Un serveur SMTP injoignable met une trentaine de secondes à expirer, et un
 * webhook d'astreinte peut en prendre autant. Règle 2 du projet : ce travail
 * n'a rien à faire dans le chemin d'une requête HTTP — ni dans celui de
 * `logAudit()`, qui est appelé au beau milieu d'une action utilisateur.
 * L'observateur du journal d'audit se contente donc d'enfiler.
 *
 * ── L'essai, lui, est attendu ───────────────────────────────────────────────
 * Le bouton « envoyer un message d'essai » veut un verdict, pas un accusé de
 * réception. Le motif retenu est celui déjà tranché pour le relevé de métriques
 * d'une cible (`/api/targets/[id]/metrics`) : la route **enfile puis attend**,
 * avec une borne franche. Elle n'exécute rien elle-même — elle attend, comme
 * elle attend une requête SQL. Et elle ne peut pas faire autrement : le panel
 * Next n'a aucun transport SMTP, `nodemailer` étant délibérément tenu hors de
 * son graphe, exactement comme `ssh2`.
 */

// ─── producteur ───────────────────────────────────────────────────────────────

let notificationsQueue: Queue | null = null;

/**
 * File des notifications, côté producteur. Le worker est ici son propre
 * producteur : c'est lui qui trace les déploiements en échec, donc lui qui
 * enfile les distributions correspondantes.
 */
export function getNotificationsQueue(): Queue {
  notificationsQueue ??= new Queue(NOTIFICATIONS_QUEUE, {
    connection: createRedisConnection(),
    defaultJobOptions: {
      /**
       * **Une seule tentative.** Rejouer une distribution partiellement
       * réussie renverrait le message aux canaux qui l'ont déjà reçu — et
       * c'est précisément ce qu'on cherche à éviter. Chaque canal enregistre
       * son propre échec ; c'est là que se lit ce qui n'est pas parti.
       */
      attempts: 1,
      removeOnComplete: { age: 24 * 3600, count: 500 },
      removeOnFail: { age: 7 * 24 * 3600 },
    },
  });
  return notificationsQueue;
}

export async function closeNotificationsQueue(): Promise<void> {
  if (notificationsQueue) {
    await notificationsQueue.close();
    notificationsQueue = null;
  }
}

/**
 * Branche le journal d'audit sur la file des notifications.
 *
 * À appeler une fois au démarrage du processus. Le panel fait la même chose de
 * son côté, depuis son `instrumentation.ts` : les deux écrivent dans
 * `audit_logs`, les deux doivent donc savoir enfiler.
 */
export function installAuditNotifications(): void {
  setAuditObserver(
    auditNotificationObserver(
      (data, dedup) =>
        getNotificationsQueue().add(NOTIFICATION_DISPATCH_JOB, data, {
          deduplication: { id: dedup.id, ttl: dedup.ttl },
        }),
      (error, event) => {
        // L'échec d'enfilement ne remonte nulle part ailleurs : sans cette
        // ligne, un Redis indisponible ferait disparaître les alertes sans un
        // mot.
        logger.error({ err: error, event }, "notification non enfilée");
      },
    ),
  );
}

// ─── distribution ─────────────────────────────────────────────────────────────

/**
 * Racine publique du panel, pour les liens des messages.
 *
 * Lue directement dans l'environnement plutôt qu'ajoutée au schéma du worker :
 * elle n'est pas une dépendance de son fonctionnement — un message sans lien
 * reste un message utile —, et le worker ne doit pas refuser de démarrer parce
 * qu'une URL d'agrément est absente. Le `.env` partagé la porte déjà pour le
 * panel (`BETTER_AUTH_URL`).
 */
function panelUrl(): string | null {
  const raw = process.env.BETTER_AUTH_URL?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

export async function handleNotificationDispatch(
  job: Job<unknown, NotificationDispatchJobResult>,
): Promise<NotificationDispatchJobResult> {
  const data = notificationDispatchJobDataSchema.parse(job.data);
  const log = logger.child({ jobId: job.id, event: data.event });

  if (!isNotificationEventKey(data.event)) {
    // Un événement retiré du catalogue entre l'enfilement et la consommation.
    log.warn('événement inconnu, distribution abandonnée');
    return { event: data.event, targeted: 0, delivered: 0, failed: 0 };
  }

  const channels = await notificationChannelsForEvent(data.event);
  if (channels.length === 0) {
    log.debug('aucun canal abonné');
    return { event: data.event, targeted: 0, delivered: 0, failed: 0 };
  }

  const [settings, actor] = await Promise.all([
    getAppSettingsValue(),
    notificationActorLabel(data.entry.actorId),
  ]);

  const message = buildNotificationMessage(data.event, data.entry, {
    instance: settings.instanceName,
    panelUrl: panelUrl(),
    actor,
    occurredAt: data.occurredAt,
  });

  /**
   * Les canaux sont servis **en parallèle**. Un serveur SMTP qui traîne ne doit
   * pas retarder le salon Discord : ce sont des destinataires différents, qui
   * n'ont aucune raison de s'attendre.
   */
  const outcomes = await Promise.all(
    channels.map(async (channel) => {
      const resolved = await resolveNotificationChannel(channel.id);
      if (!resolved) return { id: channel.id, name: channel.name, ok: false, error: 'canal disparu' };

      try {
        await getNotificationChannel(channel.kind).send(resolved.resolved, message);
        return { id: channel.id, name: channel.name, ok: true, error: null };
      } catch (error) {
        // `describeFailure` expurge : un message de fournisseur peut contenir
        // un fragment de jeton, et il finirait sinon en base et dans l'audit.
        return {
          id: channel.id,
          name: channel.name,
          ok: false,
          error: describeFailure(error, resolved.resolved.secrets),
        };
      }
    }),
  );

  for (const outcome of outcomes) {
    await recordNotificationOutcome(outcome.id, { ok: outcome.ok, error: outcome.error });
    if (outcome.ok) continue;

    log.error({ channel: outcome.name, error: outcome.error }, 'notification non délivrée');
    /**
     * L'échec est tracé. `notification.delivery.failed` n'est volontairement
     * **pas** un événement notifiable : tenter de prévenir que l'on n'a pas su
     * prévenir ferait boucler la distribution sur elle-même.
     */
    await logAudit({
      actorId: null,
      action: 'notification.delivery.failed',
      resourceType: 'notification_channel',
      resourceId: outcome.id,
      after: { event: data.event, channel: outcome.name, error: outcome.error },
    });
  }

  const delivered = outcomes.filter((outcome) => outcome.ok).length;
  log.info({ targeted: channels.length, delivered }, 'distribution terminée');

  return {
    event: data.event,
    targeted: channels.length,
    delivered,
    failed: outcomes.length - delivered,
  };
}

// ─── essai manuel ─────────────────────────────────────────────────────────────

export async function handleNotificationTest(
  job: Job<unknown, NotificationTestJobResult>,
): Promise<NotificationTestJobResult> {
  const data = notificationTestJobDataSchema.parse(job.data);
  const resolved = await resolveNotificationChannel(data.channelId);
  if (!resolved) throw new Error(`Canal « ${data.channelId} » introuvable`);

  const { row } = resolved;
  const settings = await getAppSettingsValue();
  const implementation = getNotificationChannel(row.kind);

  // Deux étapes distinctes, rapportées séparément : la sonde dit si les
  // identifiants sont bons, l'envoi dit si le destinataire est le bon. Un jeton
  // Telegram valide pointé sur une conversation inexistante passe la première
  // et rate le second — et c'est exactement ce que l'opérateur doit voir.
  const probe = await implementation.test(resolved.resolved);

  let delivered = false;
  let error: string | null = null;
  try {
    await implementation.send(
      resolved.resolved,
      testNotificationMessage({
        instance: settings.instanceName,
        panelUrl: panelUrl(),
        channelName: row.name,
      }),
    );
    delivered = true;
  } catch (sendError) {
    error = describeFailure(sendError, resolved.resolved.secrets);
  }

  await recordNotificationOutcome(row.id, { ok: delivered, error });

  logger.info(
    { channelId: row.id, kind: row.kind, probeOk: probe.ok, delivered },
    "essai d'un canal de notification",
  );

  return { channelId: row.id, kind: row.kind, probe, delivered, error };
}
