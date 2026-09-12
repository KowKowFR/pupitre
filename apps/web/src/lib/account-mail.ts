import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  ACCOUNT_MAIL_ATTEMPTS,
  ACCOUNT_MAIL_JOB,
  accountMailJobDataSchema,
  accountMailJobResultSchema,
  encrypt,
  type AccountMailJobResult,
  type AccountMailKind,
} from '@pupitre/core';
import { listNotificationChannels } from '@pupitre/db';
import type { Job } from 'bullmq';
import { HttpError } from './errors';
import { logger } from './logger';
import { getNotificationsQueue, notificationsQueueEvents } from './notifications';

/**
 * Les e-mails du cycle de vie des comptes, côté panel : **on enfile, on
 * n'envoie pas**.
 *
 * Le panel n'a aucun transport SMTP — `nodemailer` est tenu hors de son graphe
 * comme `ssh2`. Le travail réel appartient au worker
 * (`apps/worker/src/handlers/account-mail.ts`).
 */

/**
 * Durée de vie d'un lien d'invitation : 72 heures.
 *
 * Le choix se joue entre deux échecs. Trop court, l'invitation envoyée un
 * vendredi soir est morte le lundi matin, et l'administrateur passe son temps à
 * en renvoyer. Trop long, un lien qui ouvre un compte dort des mois dans une
 * boîte de réception — et une boîte de réception n'est pas un coffre-fort.
 *
 * 72 heures couvrent un week-end complet, et pas davantage. Renvoyer une
 * invitation périmée est un bouton sur `/admin/users` ; ce n'est pas un motif
 * pour allonger le lien de tout le monde.
 *
 * Ce n'est pas la durée d'une réinitialisation : celle-là vaut une heure, parce
 * que la personne qui la demande est devant son écran au moment où elle la
 * demande. Voir `PASSWORD_RESET_TTL_SECONDS` dans `./auth.ts`.
 */
export const INVITATION_TTL_MS = 72 * 3600 * 1000;

/**
 * Borne d'attente d'un envoi dont on veut le verdict.
 *
 * Même raisonnement — et même valeur — que l'essai d'un canal : le canal se
 * donne 15 s, la file peut en ajouter autant, et au-delà ce n'est plus le
 * serveur SMTP qui est lent mais le worker qui ne consomme pas.
 */
const DELIVERY_TIMEOUT_MS = 35_000;

/**
 * L'instance sait-elle poster un e-mail ?
 *
 * La question est posée à `notification_channels` : c'est là que vit la
 * configuration SMTP, saisie une fois sur `/admin/settings/notifications`, avec
 * son mot de passe chiffré. Lui en donner une seconde, propre au cycle de vie
 * des comptes, obligerait à saisir deux fois le même serveur et à découvrir un
 * jour que l'une des deux a cessé de marcher.
 *
 * On ne lit ici que la partie publique : `listNotificationChannels()` ne rend
 * jamais les secrets. Le seul déchiffrement du projet reste
 * `resolveNotificationChannel()`, appelé par le worker au moment d'envoyer.
 */
export async function mailChannelName(): Promise<string | null> {
  try {
    const channels = await listNotificationChannels();
    const smtp = channels.find(
      (channel) =>
        channel.kind === 'smtp' &&
        channel.enabled &&
        typeof channel.config.host === 'string' &&
        channel.config.host.trim().length > 0,
    );
    return smtp?.name ?? null;
  } catch (error) {
    // Une base injoignable ne doit pas faire tomber un écran de connexion. On
    // répond « pas de canal » : le pire qui arrive est qu'un lien « mot de passe
    // oublié » soit masqué à tort, ce qui est exactement le comportement voulu
    // quand on ne sait pas.
    logger.error({ err: error }, 'lecture des canaux de notification impossible');
    return null;
  }
}

/** `true` si un e-mail de compte a une chance de partir. */
export async function canSendAccountMail(): Promise<boolean> {
  return (await mailChannelName()) !== null;
}

export type AccountMailRequest = {
  kind: AccountMailKind;
  userId: string;
  to: string;
  recipientName: string;
  /** Lien porteur du jeton. Chiffré avant d'entrer dans la file. */
  url: string;
  expiresAt: Date;
  /** Qui a déclenché l'envoi, quand quelqu'un l'a déclenché. */
  actor?: string | null;
};

function toJobData(request: AccountMailRequest) {
  return accountMailJobDataSchema.parse({
    kind: request.kind,
    userId: request.userId,
    to: request.to,
    recipientName: request.recipientName,
    // Le jeton ne traverse Redis que chiffré. Voir le commentaire du schéma
    // dans `@pupitre/core/queue` pour le raisonnement complet.
    encryptedUrl: encrypt(request.url),
    expiresAt: request.expiresAt.toISOString(),
    actor: request.actor ?? null,
  });
}

/**
 * Rétention volontairement courte.
 *
 * La charge est chiffrée, mais une tâche terminée n'apprend plus rien à
 * personne : le verdict est déjà dans `audit_logs` (`account.mail.sent` /
 * `account.mail.failed`). Soixante secondes laissent seulement à l'appelant le
 * temps de lire le résultat.
 */
const JOB_OPTIONS = {
  attempts: ACCOUNT_MAIL_ATTEMPTS,
  removeOnComplete: { age: 60, count: 20 },
  removeOnFail: { age: 3600, count: 50 },
} as const;

/**
 * ## Le problème que résout ce petit bout de contexte asynchrone
 *
 * C'est Better Auth qui fabrique le jeton, et il ne le donne qu'à un endroit :
 * son rappel `sendResetPassword`. Ce rappel ne sait pas *qui* l'a déclenché —
 * le formulaire public « mot de passe oublié », ou un administrateur qui
 * invite. Or les deux n'ont pas le même besoin :
 *
 *   — la réinitialisation publique **ne doit pas attendre** l'envoi. Sinon le
 *     chemin « ce compte existe » durerait quelques secondes de plus que le
 *     chemin « cette adresse est inconnue », et n'importe qui pourrait
 *     chronométrer la différence. L'anti-énumération de Better Auth serait
 *     annulée par notre propre code ;
 *   — l'invitation **doit** attendre : un administrateur regarde son écran, et
 *     « c'est enfilé » ne lui apprend rien sur ce qui est réellement parti.
 *
 * `AsyncLocalStorage` porte cette différence sans variable globale ni
 * paramètre à faire traverser Better Auth : l'appelant qui veut le verdict
 * ouvre un contexte, l'envoi qui s'y produit y dépose sa tâche, et l'appelant
 * l'attend. Hors contexte — le cas par défaut —, l'envoi part en arrière-plan.
 *
 * Cela repose sur un fait vérifié dans la version installée : Better Auth
 * **attend** `sendResetPassword` (`runInBackgroundOrAwait` ne bascule en
 * arrière-plan que si `advanced.backgroundTasks.handler` est configuré, ce
 * qu'on ne fait pas). Si cela changeait, `captureAccountMail()` rendrait un
 * verdict `null` — dégradation, pas panne : voir son commentaire.
 */
type MailScope = { pending: Promise<Job> | null };

const mailScope = new AsyncLocalStorage<MailScope>();

/**
 * Enfile. Attend si — et seulement si — l'appelant a ouvert un contexte de
 * capture ; part en arrière-plan sinon.
 */
export function sendAccountMail(request: AccountMailRequest): void {
  const pending = getNotificationsQueue().add(ACCOUNT_MAIL_JOB, toJobData(request), JOB_OPTIONS);

  const scope = mailScope.getStore();
  if (scope) {
    scope.pending = pending;
    // Une rejection non traitée tuerait le processus si l'appelant abandonne
    // avant d'attendre. Le `catch` ici ne masque rien : `captureAccountMail()`
    // relit la même promesse et la traitera.
    pending.catch(() => undefined);
    return;
  }

  void pending.catch((error: unknown) => {
    // Sans cette ligne, un Redis indisponible ferait disparaître les
    // réinitialisations sans un mot, et personne ne comprendrait pourquoi
    // « le mail n'arrive jamais ».
    logger.error({ err: error, kind: request.kind }, 'e-mail de compte non enfilé');
  });
}

/**
 * Exécute `fn` et rend, en plus de son résultat, le verdict de l'e-mail qu'il a
 * déclenché.
 *
 * `verdict: null` signifie « aucun e-mail n'est parti pendant cet appel » — par
 * exemple parce que Better Auth n'a trouvé aucun compte. L'appelant décide de
 * ce que cela veut dire chez lui ; ici on ne devine pas.
 */
export async function captureAccountMail<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; verdict: AccountMailJobResult | null }> {
  const scope: MailScope = { pending: null };
  const value = await mailScope.run(scope, fn);

  if (!scope.pending) return { value, verdict: null };

  const job = await scope.pending;

  let raw: unknown;
  try {
    raw = await job.waitUntilFinished(notificationsQueueEvents(), DELIVERY_TIMEOUT_MS);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/timed out/i.test(message)) {
      throw new HttpError(
        504,
        'account_mail_timeout',
        "L'e-mail n'est pas parti dans le délai imparti. Le worker est peut-être saturé — " +
          'le compte existe, vous pouvez relancer l’invitation.',
      );
    }
    // Le worker a rapporté un échec (serveur SMTP injoignable, adresse
    // refusée…). Le message est déjà expurgé de tout secret par
    // `describeFailure()` côté worker.
    throw new HttpError(502, 'account_mail_failed', `L’e-mail n’est pas parti : ${message}`);
  }

  const parsed = accountMailJobResultSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(502, 'account_mail_failed', 'Le worker a renvoyé un verdict illisible');
  }
  return { value, verdict: parsed.data };
}
