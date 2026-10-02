import { auditQuerySchema, getAppSettings, iterateAuditLogs, logAudit } from '@pupitre/db';
import { expandDayRange } from '@/lib/day-range';
import { exportResponse } from '@/lib/export';
import { apiRoute, searchParamsOf } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Les filtres de la liste, sans pagination ni ordre : l'export prend tout, du plus récent au plus ancien. */
const querySchema = auditQuerySchema.pick({
  actorId: true,
  action: true,
  resourceType: true,
  from: true,
  to: true,
});

/**
 * Plafond d'un export : aucune requête HTTP ne doit devenir une opération
 * longue (règle 2). Au-delà, on resserre les filtres — la date surtout. Le
 * plafond atteint est dit au journal (`truncated`).
 */
const EXPORT_MAX_ROWS = 100_000;

/**
 * Export du journal d'activité en JSON Lines : une entrée par ligne, telle
 * qu'elle est en base, charge utile comprise. Le format se lit avec `jq`, se
 * découpe avec `split`, et s'ingère tel quel dans un outil de SIEM.
 *
 * L'export lui-même est une entrée du journal (`audit.exported`), écrite une
 * fois le flux terminé ou interrompu : sortir la trace de qui a fait quoi est
 * précisément le genre de geste qu'elle doit garder.
 */
export const GET = apiRoute(async (request) => {
  const auth = await requirePermission(request, 'audit:read');
  // Mêmes jours que la liste : lus dans le fuseau de l'instance, « Au » compris.
  const { settings } = await getAppSettings();
  const filter = querySchema.parse(expandDayRange(searchParamsOf(request), settings.timezone));

  let rows = 0;
  async function* chunks(): AsyncGenerator<string, void, undefined> {
    for await (const batch of iterateAuditLogs(filter, { limit: EXPORT_MAX_ROWS })) {
      let chunk = '';
      for (const entry of batch) {
        chunk += `${JSON.stringify({
          id: entry.id,
          createdAt: entry.createdAt.toISOString(),
          actorId: entry.actorId,
          actorEmail: entry.actorEmail,
          action: entry.action,
          resourceType: entry.resourceType,
          resourceId: entry.resourceId,
          ip: entry.ip,
          userAgent: entry.userAgent,
          apiToken: entry.apiTokenName,
          before: entry.before,
          after: entry.after,
        })}\n`;
      }
      rows += batch.length;
      yield chunk;
    }
  }

  const stamp = new Date().toISOString().slice(0, 10);

  return exportResponse({
    chunks: chunks(),
    contentType: 'application/x-ndjson; charset=utf-8',
    filename: `pupitre-journal-${stamp}.jsonl`,
    fallbackName: 'pupitre-journal.jsonl',
    context: { export: 'audit' },
    onSettled: async (complete) => {
      await logAudit({
        actorId: auth.userId,
        action: 'audit.exported',
        resourceType: 'audit_log',
        after: {
          format: 'jsonl',
          filters: {
            ...filter,
            from: filter.from?.toISOString(),
            to: filter.to?.toISOString(),
          },
          rows,
          complete,
          truncated: rows >= EXPORT_MAX_ROWS,
        },
        ip: auth.ip,
      });
    },
  });
});
