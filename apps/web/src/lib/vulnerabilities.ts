import 'server-only';
import type { VulnerabilityAcceptanceView } from '@pupitre/db';

/** An acceptance as the screen and the API return it. */
export type AcceptanceJson = {
  id: string;
  cveId: string;
  package: string | null;
  reason: string;
  expiresAt: string | null;
  expired: boolean;
  authorName: string | null;
  createdAt: string;
};

export function acceptanceJson(
  row: VulnerabilityAcceptanceView,
  now: Date = new Date(),
): AcceptanceJson {
  return {
    id: row.id,
    cveId: row.cveId,
    package: row.package,
    reason: row.reason,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    expired: row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime(),
    authorName: row.authorName,
    createdAt: row.createdAt.toISOString(),
  };
}
