import 'server-only';
import type { PurgeReport } from '@tp/db';

/**
 * Une seule entrée d'audit par appel de purge, jamais une par déploiement :
 * mille lignes « deployment.purged » noieraient le journal au lieu de le
 * renseigner.
 *
 * Elle porte la liste complète des identifiants tant qu'elle reste lisible —
 * au-delà, c'est le décompte et la ventilation par statut qui font foi. Ces
 * identifiants sont la **seule** trace restante de ce qui a disparu : les
 * rogner trop tôt reviendrait à purger l'historique de la purge.
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
