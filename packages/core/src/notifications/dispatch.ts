import {
  NOTIFICATION_DEDUP_TTL_MS,
  notificationDedupKey,
  type NotificationDispatchJobData,
} from '../queue.js';
import { notifiableEventFor, type NotifiableAuditEntry } from './events.js';

/**
 * Le branchement entre le journal d'audit et la file des notifications.
 *
 * Il vit ici, et non dans le panel ou dans le worker, parce que les deux
 * processus écrivent dans `audit_logs` et doivent se comporter **exactement**
 * pareil : un déploiement en échec est tracé par le worker, un changement de
 * rôle par le panel. Deux copies de cette logique finiraient par diverger, et
 * la divergence se verrait sous la forme d'un incident non notifié.
 *
 * Ce module ne connaît ni BullMQ, ni Redis, ni `@tp/db` : il reçoit une
 * fonction d'enfilement. C'est ce qui lui permet de vivre à la racine de
 * `@tp/core`, donc d'être appelable des deux côtés.
 */

/** Une ligne d'`audit_logs`, décrite structurellement. */
export type AuditRowLike = {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  actorId: string | null;
  before: unknown;
  after: unknown;
  createdAt: Date;
};

export type NotificationDedup = { id: string; ttl: number };

export type NotificationEnqueue = (
  data: NotificationDispatchJobData,
  dedup: NotificationDedup,
) => Promise<unknown>;

/**
 * Fabrique l'observateur à poser sur `setAuditObserver()`.
 *
 * Il est **synchrone** et rend la main immédiatement : l'enfilement part en
 * tâche de fond, et son échec est rapporté sur `onError` sans jamais remonter.
 * Une notification qui ne part pas ne doit pas casser l'action qu'elle décrit —
 * c'est la même règle que pour `logAudit()` lui-même. Mais elle ne doit pas
 * échouer en silence non plus : d'où `onError`, qui n'a pas de valeur par
 * défaut, pour qu'aucun appelant ne puisse l'oublier.
 */
export function auditNotificationObserver(
  enqueue: NotificationEnqueue,
  onError: (error: unknown, event: string) => void,
): (row: AuditRowLike) => void {
  return (row) => {
    const entry: NotifiableAuditEntry = {
      action: row.action,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      actorId: row.actorId,
      before: row.before,
      after: row.after,
    };

    const event = notifiableEventFor(entry);
    if (!event) return;

    const data: NotificationDispatchJobData = {
      event,
      auditLogId: row.id,
      occurredAt: row.createdAt.toISOString(),
      entry,
    };

    void enqueue(data, {
      id: notificationDedupKey(event, row.resourceId),
      ttl: NOTIFICATION_DEDUP_TTL_MS,
    }).catch((error: unknown) => {
      onError(error, event);
    });
  };
}
