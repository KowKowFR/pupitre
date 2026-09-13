import {
  NOTIFICATIONS_QUEUE,
  NOTIFICATION_DELIVER_ATTEMPTS,
  NOTIFICATION_DELIVER_BACKOFF_MS,
  NOTIFICATION_DELIVER_JOB,
  NOTIFICATION_DIGEST_SWEEP_EVERY_MS,
  NOTIFICATION_DIGEST_SWEEP_JOB,
  NOTIFICATION_DISPATCH_JOB,
  auditNotificationObserver,
  buildNotificationDigest,
  buildNotificationDigestItem,
  buildNotificationMessage,
  describeFailure,
  isNotificationEventKey,
  languageOf,
  notificationDeliverJobDataSchema,
  notificationDigestGroupKey,
  notificationDigestPath,
  notificationDispatchJobDataSchema,
  notificationEventDescriptor,
  notificationEventLabel,
  notificationPayloadEvent,
  notificationTestJobDataSchema,
  testNotificationMessage,
  type NotificationDeliverJobResult,
  type NotificationDigestSweepJobResult,
  type NotificationDispatchJobResult,
  type NotificationPayload,
  type NotificationRenderContext,
  type NotificationTestJobResult,
} from '@pupitre/core';
import { deliverNotification, getNotificationChannel } from '@pupitre/core/notifications';
import {
  admitNotification,
  claimNotificationDigest,
  dueNotificationDigestGroups,
  getAppSettingsValue,
  logAudit,
  notificationActorLabel,
  notificationChannelsForEvent,
  recordNotificationOutcome,
  resolveNotificationChannel,
  setAuditObserver,
  type NotificationChannelRecord,
} from '@pupitre/db';
import { Queue, UnrecoverableError, type Job } from 'bullmq';
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
 * ── Trois tâches, trois responsabilités ─────────────────────────────────────
 *   `notification:dispatch`      décide : ce message part-il maintenant, ou
 *                                est-il retenu pour être résumé ?
 *   `notification:deliver`       délivre à **un** canal, et se rejoue seule
 *   `notification:digest_sweep`  ferme les fenêtres échues et compose les résumés
 *
 * Le découpage entre décider et délivrer est ce qui rend le rejeu correct :
 * l'objection de la première version — « rejouer une distribution partiellement
 * réussie renverrait le message aux canaux qui l'ont déjà reçu » — ne tient
 * plus dès lors qu'une tâche ne concerne qu'un destinataire.
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
       * **Une seule tentative par défaut.** Elle vaut pour la décision
       * (`dispatch`) et pour le balayage : les rejouer ne réparerait rien et
       * pourrait dédoubler un résumé. Les tâches de *remise*, elles, demandent
       * explicitement leurs trois tentatives — voir `enqueueDeliveries()`.
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

/**
 * Installe l'horloge qui ferme les fenêtres de regroupement.
 *
 * Aucune ligne en base pour ce scheduler, donc aucune réconciliation : c'est un
 * détail d'exécution, réinstallé à l'identique à chaque démarrage. Ce qui vit en
 * base, c'est l'état des fenêtres — et c'est justement ce qui fait qu'un worker
 * redémarré au milieu d'un orage retrouve ses fenêtres ouvertes au lieu de
 * relâcher tout d'un coup. Même construction que le balayage des sondes.
 */
export async function installNotificationDigestSweep(): Promise<void> {
  await getNotificationsQueue().upsertJobScheduler(
    'notification-digest-sweep',
    { every: NOTIFICATION_DIGEST_SWEEP_EVERY_MS },
    {
      name: NOTIFICATION_DIGEST_SWEEP_JOB,
      data: {},
      opts: {
        attempts: 1,
        // La cadence est de quelques secondes : conserver mille occurrences
        // n'apprendrait rien et encombrerait Redis.
        removeOnComplete: { age: 600, count: 50 },
        removeOnFail: { age: 24 * 3600, count: 50 },
      },
    },
  );
  logger.info(
    { everyMs: NOTIFICATION_DIGEST_SWEEP_EVERY_MS },
    'balayage des fenêtres de regroupement installé',
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

/**
 * Enfile une remise par canal abonné.
 *
 * `addBulk` et non une boucle d'`add` : c'est un aller-retour Redis au lieu de
 * quatre, sur un chemin qui doit rester court — c'est lui qui sépare l'incident
 * de la première alerte.
 *
 * La charge utile voyage **composée**. Recomposer dans la remise ferait qu'un
 * rejeu trois minutes plus tard produirait un message différent de celui reçu
 * par les autres canaux ; et cela rendrait chaque tentative dépendante de la
 * base. Aucun secret n'y transite : le message neutre n'en contient pas, la
 * configuration du canal est relue au moment d'envoyer.
 */
async function enqueueDeliveries(
  channels: NotificationChannelRecord[],
  payload: NotificationPayload,
): Promise<number> {
  if (channels.length === 0) return 0;

  await getNotificationsQueue().addBulk(
    channels.map((channel) => ({
      name: NOTIFICATION_DELIVER_JOB,
      data: { channelId: channel.id, channelName: channel.name, payload },
      opts: {
        attempts: NOTIFICATION_DELIVER_ATTEMPTS,
        backoff: { type: 'exponential', delay: NOTIFICATION_DELIVER_BACKOFF_MS },
        removeOnComplete: { age: 24 * 3600, count: 500 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    })),
  );

  return channels.length;
}

/**
 * Décide du sort d'un événement notifiable.
 *
 * Le chemin « immédiat » est le chemin par défaut et il est **court** : lire les
 * canaux abonnés, composer, décider, enfiler. Aucune attente, aucun délai
 * volontaire. Un digest qui retarderait la première alerte aurait échangé un
 * défaut contre un pire.
 */
export async function handleNotificationDispatch(
  job: Job<unknown, NotificationDispatchJobResult>,
): Promise<NotificationDispatchJobResult> {
  const data = notificationDispatchJobDataSchema.parse(job.data);
  const log = logger.child({ jobId: job.id, event: data.event });

  const nothing = (mode: 'skipped') => ({
    event: data.event,
    targeted: 0,
    delivered: 0,
    failed: 0,
    mode,
    queued: 0,
  });

  if (!isNotificationEventKey(data.event)) {
    // Un événement retiré du catalogue entre l'enfilement et la consommation.
    log.warn('événement inconnu, distribution abandonnée');
    return nothing('skipped');
  }

  const channels = await notificationChannelsForEvent(data.event);
  if (channels.length === 0) {
    // Personne n'écoute : on ne touche pas non plus à l'état de regroupement.
    // Ouvrir une fenêtre pour un événement que nul ne reçoit ferait retenir la
    // première alerte du jour où quelqu'un s'abonnera.
    log.debug('aucun canal abonné');
    return nothing('skipped');
  }

  const [settings, actor] = await Promise.all([
    getAppSettingsValue(),
    notificationActorLabel(data.entry.actorId),
  ]);

  const ctx: NotificationRenderContext = {
    instance: settings.instanceName,
    panelUrl: panelUrl(),
    actor,
    occurredAt: data.occurredAt,
    // Personne n'est devant l'écran : la langue de l'alerte est celle de
    // l'instance, la même que le panel et que les e-mails d'invitation.
    language: languageOf(settings.locale),
  };

  const message = buildNotificationMessage(data.event, data.entry, ctx);
  const item = buildNotificationDigestItem(data.event, data.entry, ctx);

  const admission = await admitNotification({
    groupKey: notificationDigestGroupKey(data.event),
    event: data.event,
    item,
  });

  if (admission.mode === 'held') {
    log.info(
      {
        heldCount: admission.heldCount,
        windowEndsAt: admission.windowEndsAt.toISOString(),
        label: item.label,
      },
      'alerte retenue pour regroupement',
    );
    return {
      event: data.event,
      targeted: channels.length,
      delivered: 0,
      failed: 0,
      mode: 'held',
      queued: 0,
    };
  }

  const queued = await enqueueDeliveries(channels, { type: 'event', message });
  log.info({ targeted: channels.length, queued }, 'alerte enfilée sans délai');

  return {
    event: data.event,
    targeted: channels.length,
    delivered: 0,
    failed: 0,
    mode: 'immediate',
    queued,
  };
}

/**
 * Ferme les fenêtres échues et compose les résumés.
 *
 * Le balayage est **sans état** : il relit la base, ne suppose rien de ce qui
 * s'est passé avant, et peut donc être interrompu, redémarré ou exécuté par un
 * autre worker sans conséquence. La transaction de `claimNotificationDigest()`
 * garantit qu'un groupe n'est résumé qu'une fois même si deux balayages se
 * croisent.
 */
export async function handleNotificationDigestSweep(
  job: Job<unknown, NotificationDigestSweepJobResult>,
): Promise<NotificationDigestSweepJobResult> {
  const groups = await dueNotificationDigestGroups();
  if (groups.length === 0) return { examined: 0, digests: 0, queued: 0 };

  const log = logger.child({ jobId: job.id });
  let digests = 0;
  let queued = 0;

  for (const groupKey of groups) {
    const claim = await claimNotificationDigest(groupKey);
    // `null` : la fenêtre s'est refermée sans rien avoir retenu. Le groupe
    // redevient silencieux, la prochaine panne isolée repartira sans délai.
    if (!claim) continue;

    if (!isNotificationEventKey(claim.event)) {
      log.warn({ groupKey, event: claim.event }, 'résumé abandonné : événement hors catalogue');
      continue;
    }

    const channels = await notificationChannelsForEvent(claim.event);
    if (channels.length === 0) {
      // Tous les abonnements ont été retirés pendant la fenêtre. On le dit :
      // des alertes retenues disparaissent ici, et un silence serait trompeur.
      log.warn(
        { groupKey, count: claim.count },
        'résumé sans destinataire : plus aucun canal abonné',
      );
      continue;
    }

    const settings = await getAppSettingsValue();
    const descriptor = notificationEventDescriptor(claim.event);
    const language = languageOf(settings.locale);

    const digest = buildNotificationDigest({
      event: claim.event,
      severity: descriptor.severity,
      eventLabel: notificationEventLabel(claim.event, language),
      items: claim.items,
      count: claim.count,
      windowStartedAt: claim.windowStartedAt.toISOString(),
      windowEndedAt: claim.windowEndedAt.toISOString(),
      windowMs: claim.windowMs,
      nextWindowMs: claim.nextWindowMs,
      instance: settings.instanceName,
      panelUrl: panelUrl(),
      path: notificationDigestPath(claim.event),
      language,
    });

    digests += 1;
    queued += await enqueueDeliveries(channels, { type: 'digest', digest });

    log.info(
      { groupKey, count: claim.count, named: claim.items.length, nextWindowMs: claim.nextWindowMs },
      'résumé composé',
    );
  }

  return { examined: groups.length, digests, queued };
}

/**
 * Délivre à **un** canal.
 *
 * Trois tentatives, un seul destinataire : le rejeu ne peut donc rien renvoyer
 * à quelqu'un qui avait déjà reçu. La remise est *au moins une fois* — un envoi
 * réussi dont l'accusé se perd partira deux fois. C'est l'arbitrage assumé : un
 * message en double est une gêne, un message d'incident jamais parti est une
 * panne.
 *
 * L'issue n'est enregistrée qu'**une fois**, au terme : sur un succès, ou sur la
 * dernière tentative ratée. Compter chaque tentative gonflerait
 * `consecutive_failures`, qui répond à « depuis quand ce canal ne marche
 * plus ? » et non à « combien de paquets ont été perdus ? ».
 */
export async function handleNotificationDeliver(
  job: Job<unknown, NotificationDeliverJobResult>,
): Promise<NotificationDeliverJobResult> {
  const data = notificationDeliverJobDataSchema.parse(job.data);
  const event = notificationPayloadEvent(data.payload);
  const attempt = (job.attemptsMade ?? 0) + 1;
  const maxAttempts = job.opts.attempts ?? 1;
  const log = logger.child({ jobId: job.id, event, channel: data.channelName, attempt });

  const resolved = await resolveNotificationChannel(data.channelId);
  if (!resolved) {
    // Canal supprimé entre la décision et la remise. Rien à réparer : rejouer
    // ne le ferait pas réapparaître.
    log.warn('canal disparu, remise abandonnée');
    throw new UnrecoverableError(`canal « ${data.channelName} » introuvable`);
  }

  try {
    await deliverNotification(
      getNotificationChannel(resolved.row.kind),
      resolved.resolved,
      data.payload,
    );
  } catch (error) {
    // `describeFailure` expurge : un message de fournisseur peut contenir un
    // fragment de jeton, et il finirait sinon en base et dans l'audit.
    const detail = describeFailure(error, resolved.resolved.secrets);

    if (attempt < maxAttempts) {
      log.warn({ error: detail }, 'remise en échec, nouvelle tentative programmée');
      throw error;
    }

    await recordNotificationOutcome(data.channelId, { ok: false, error: detail });
    log.error({ error: detail }, 'notification non délivrée');

    /**
     * L'échec est tracé. `notification.delivery.failed` n'est volontairement
     * **pas** un événement notifiable : tenter de prévenir que l'on n'a pas su
     * prévenir ferait boucler la distribution sur elle-même.
     */
    await logAudit({
      actorId: null,
      action: 'notification.delivery.failed',
      resourceType: 'notification_channel',
      resourceId: data.channelId,
      after: {
        event,
        channel: data.channelName,
        error: detail,
        attempts: attempt,
        digest: data.payload.type === 'digest',
      },
    });

    throw new Error(detail);
  }

  await recordNotificationOutcome(data.channelId, { ok: true });
  log.info({ digest: data.payload.type === 'digest' }, 'notification délivrée');

  return { channelId: data.channelId, event, delivered: true, attempt, error: null };
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
  const language = languageOf(settings.locale);
  const implementation = getNotificationChannel(row.kind);

  // Deux étapes distinctes, rapportées séparément : la sonde dit si les
  // identifiants sont bons, l'envoi dit si le destinataire est le bon. Un jeton
  // Telegram valide pointé sur une conversation inexistante passe la première
  // et rate le second — et c'est exactement ce que l'opérateur doit voir.
  const probe = await implementation.test(resolved.resolved, language);

  let delivered = false;
  let error: string | null = null;
  try {
    await implementation.send(
      resolved.resolved,
      testNotificationMessage({
        instance: settings.instanceName,
        panelUrl: panelUrl(),
        channelName: row.name,
        language,
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
