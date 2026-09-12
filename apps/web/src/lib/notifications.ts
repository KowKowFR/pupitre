import 'server-only';
import {
  NOTIFICATIONS_QUEUE,
  NOTIFICATION_DISPATCH_JOB,
  NOTIFICATION_TEST_JOB,
  auditNotificationObserver,
  notificationTestJobDataSchema,
  notificationTestJobResultSchema,
  type NotificationTestJobResult,
} from '@pupitre/core';
import { setAuditObserver } from '@pupitre/db';
import { Queue, QueueEvents } from 'bullmq';
import { HttpError } from './errors';
import { logger } from './logger';
import { getRedis } from './redis';

/**
 * Plomberie des notifications, côté panel.
 *
 * Le panel **n'envoie rien lui-même** : `nodemailer` est délibérément tenu hors
 * de son graphe de dépendances, exactement comme `ssh2`. Il enfile, et le
 * worker délivre.
 */

declare global {
  var __tpNotificationsQueue: Queue | undefined;
  var __tpNotificationsQueueEvents: QueueEvents | undefined;
}

export function getNotificationsQueue(): Queue {
  globalThis.__tpNotificationsQueue ??= new Queue(NOTIFICATIONS_QUEUE, {
    connection: getRedis(),
    defaultJobOptions: {
      // Une seule tentative : rejouer une distribution partiellement réussie
      // renverrait le message aux canaux qui l'ont déjà reçu.
      attempts: 1,
      removeOnComplete: { age: 24 * 3600, count: 500 },
      removeOnFail: { age: 7 * 24 * 3600 },
    },
  });
  return globalThis.__tpNotificationsQueue;
}

/**
 * Branche le journal d'audit sur la file des notifications.
 *
 * Appelé une fois, depuis `instrumentation.ts`, avant que le serveur n'accepte
 * la première requête. Le worker fait la même chose de son côté : les deux
 * processus écrivent dans `audit_logs`, les deux doivent savoir enfiler. C'est
 * le panel qui trace un changement de rôle ou une réinitialisation de second
 * facteur ; c'est le worker qui trace un déploiement en échec.
 */
export function installAuditNotifications(): void {
  setAuditObserver(
    auditNotificationObserver(
      (data, dedup) =>
        getNotificationsQueue().add(NOTIFICATION_DISPATCH_JOB, data, {
          deduplication: { id: dedup.id, ttl: dedup.ttl },
        }),
      (error, event) => {
        // Sans cette ligne, un Redis indisponible ferait disparaître les
        // alertes sans un mot. L'action, elle, n'est jamais interrompue.
        logger.error({ err: error, event }, 'notification non enfilée');
      },
    ),
  );
}

/**
 * Borne de l'essai déclenché depuis l'écran.
 *
 * Le canal lui-même se donne 15 s (`NOTIFICATION_TIMEOUT_MS`), et un essai en
 * enchaîne deux — la sonde puis l'envoi. Trente-cinq secondes couvrent donc le
 * pire cas légitime plus l'attente en file. Au-delà, ce n'est plus le
 * destinataire qui est lent, c'est le worker qui ne consomme pas, et l'appelant
 * mérite un 504 franc plutôt qu'une connexion tenue ouverte.
 */
const TEST_TIMEOUT_MS = 35_000;

function queueEvents(): QueueEvents {
  globalThis.__tpNotificationsQueueEvents ??= new QueueEvents(NOTIFICATIONS_QUEUE, {
    connection: getRedis(),
  });
  return globalThis.__tpNotificationsQueueEvents;
}

/**
 * Essai d'un canal : la route **enfile puis attend**.
 *
 * La règle du projet est que le *travail* long n'a pas sa place dans une route
 * HTTP — pas que la route doive rendre la main avant de savoir. C'est
 * l'arbitrage déjà tranché pour le relevé de métriques d'une cible
 * (`/api/targets/[id]/metrics`), et il vaut ici pour la même raison, doublée
 * d'une contrainte : le panel n'a aucun transport SMTP. Un bouton « envoyer un
 * message d'essai » qui répondrait « c'est parti » sans dire si c'est arrivé ne
 * servirait à rien — une configuration fausse ne se découvrirait qu'au premier
 * incident, c'est-à-dire au pire moment.
 */
export async function runChannelTest(
  channelId: string,
  actorId: string,
  ip: string | null,
): Promise<NotificationTestJobResult> {
  const data = notificationTestJobDataSchema.parse({ channelId, actorId, ip });

  // Aucun identifiant de tâche personnalisé : BullMQ refuse un « Custom Id »
  // contenant un `:`, et le nom de cette tâche en contient un.
  const job = await getNotificationsQueue().add(NOTIFICATION_TEST_JOB, data, { attempts: 1 });

  let raw: unknown;
  try {
    raw = await job.waitUntilFinished(queueEvents(), TEST_TIMEOUT_MS);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // `waitUntilFinished` ne distingue le dépassement du délai de l'échec de la
    // tâche que par son message — deux situations, deux codes.
    if (/timed out/i.test(message)) {
      throw new HttpError(
        504,
        'notification_test_timeout',
        "L'essai n'a pas abouti dans le délai imparti. Le worker est peut-être saturé.",
      );
    }
    throw new HttpError(502, 'notification_test_failed', `Essai impossible : ${message}`);
  }

  const parsed = notificationTestJobResultSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(502, 'notification_test_failed', 'Le worker a renvoyé un verdict illisible');
  }
  return parsed.data;
}
