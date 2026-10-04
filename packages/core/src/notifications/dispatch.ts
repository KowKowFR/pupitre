import {
  NOTIFICATION_DEDUP_TTL_MS,
  notificationDedupKey,
  type NotificationDispatchJobData,
} from '../queue.js';
import {
  notifiableEventFor,
  notificationDedupDiscriminator,
  type NotifiableAuditEntry,
} from './events.js';

/**
 * The connection between the audit log and the notifications queue.
 *
 * It lives here, and not in the panel or the worker, because both processes
 * write into `audit_logs` and must behave **exactly** the same: a failed
 * deployment is recorded by the worker, a role change by the panel. Two copies
 * of this logic would end up diverging, and the divergence would show as an
 * incident not notified.
 *
 * This module knows neither BullMQ, nor Redis, nor `@pupitre/db`: it receives a
 * queuing function. That is what lets it live at the root of `@pupitre/core`,
 * hence be callable from both sides.
 */

/** An `audit_logs` row, described structurally. */
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
 * Builds the observer to set on `setAuditObserver()`.
 *
 * It is **synchronous** and returns immediately: queuing goes on in the
 * background, and its failure is reported on `onError` without ever bubbling
 * up. A notification that does not go out must not break the action it
 * describes — the same rule as for `logAudit()` itself. But it must not fail
 * silently either: hence `onError`, which has no default value, so that no
 * caller can forget it.
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
      id: notificationDedupKey(
        event,
        row.resourceId,
        notificationDedupDiscriminator(event, entry),
      ),
      ttl: NOTIFICATION_DEDUP_TTL_MS,
    }).catch((error: unknown) => {
      onError(error, event);
    });
  };
}
