import 'server-only';
import type { PurgeReport } from '@pupitre/db';

/**
 * A single audit entry per purge call, never one per deployment: a thousand
 * "deployment.purged" rows would drown the log instead of informing it.
 *
 * It carries the complete list of identifiers as long as it stays readable —
 * beyond that, it is the count and the breakdown per status that count. These
 * identifiers are the **only** remaining trace of what disappeared: trimming
 * them too early would amount to purging the purge's history.
 */
const AUDIT_ID_LIMIT = 200;

export function purgeAuditPayload(
  report: PurgeReport,
  filter: unknown,
): Record<string, unknown> {
  const refusedByReason: Record<string, number> = {};
  for (const refusal of report.refused) {
    refusedByReason[refusal.reason] = (refusedByReason[refusal.reason] ?? 0) + 1;
  }

  return {
    filter,
    matched: report.matched,
    purgedCount: report.purgedCount,
    purgedByStatus: report.purgedByStatus,
    ...(report.purgedCount <= AUDIT_ID_LIMIT
      ? { purgedIds: report.purged }
      : { purgedIdsOmitted: report.purgedCount }),
    refusedCount: report.refusedCount,
    refusedByReason,
    releasedPorts: report.releasedPorts,
    rollbackTargetsLost: report.rollbackTargetsLost,
    truncated: report.truncated,
  };
}
