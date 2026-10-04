import { auditSeverityOf } from '@pupitre/core';
import { auditQuerySchema, getAppSettings, iterateAuditLogs, logAudit } from '@pupitre/db';
import { expandDayRange } from '@/lib/day-range';
import { exportResponse } from '@/lib/export';
import { apiRoute, searchParamsOf } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The list's filters, without pagination or order: the export takes everything, newest first. */
const querySchema = auditQuerySchema.pick({
  q: true,
  severity: true,
  actorId: true,
  action: true,
  resourceType: true,
  from: true,
  to: true,
});

/**
 * An export's cap: no HTTP request must become a long-running operation (rule 2).
 * Beyond it, one narrows the filters — the date above all. The cap reached is
 * said in the log (`truncated`).
 */
const EXPORT_MAX_ROWS = 100_000;

/**
 * Exporting the activity log as JSON Lines: one entry per line, as it is in the
 * database, payload included. The format reads with `jq`, splits with `split`,
 * and is ingested as is by a SIEM tool.
 *
 * The export itself is a log entry (`audit.exported`), written once the stream
 * has finished or been interrupted: taking out the trace of who did what is
 * precisely the kind of gesture it must keep.
 */
export const GET = apiRoute(async (request) => {
  const auth = await requirePermission(request, 'audit:read');
  // The same days as the list: read in the instance's time zone, "To" included.
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
          severity: auditSeverityOf(entry.action),
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
