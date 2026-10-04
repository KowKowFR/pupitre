import {
  deploymentQuerySchema,
  iterateDeployments,
  logAudit,
  scanDigestForDeployments,
} from '@pupitre/db';
import { csvRow } from '@/lib/csv';
import { exportResponse } from '@/lib/export';
import { apiRoute, readSearchParams } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The list's filters, without its pagination: the export takes all the pages. */
const querySchema = deploymentQuerySchema.omit({ page: true, pageSize: true });

/**
 * An export's cap. An instance is very far from it; the bound exists so that no
 * HTTP request can become a long-running operation (rule 2). Reached, it is said
 * in the activity log (`truncated`).
 */
const EXPORT_MAX_ROWS = 50_000;

/**
 * The file's columns. Technical, stable names, and not translated labels: an
 * export is read back by a script or a spreadsheet months later, whatever the
 * language set in the meantime. The dates are ISO 8601 UTC.
 */
const COLUMNS = [
  'run',
  'application',
  'target',
  'host',
  'runtime',
  'status',
  'failed_step',
  'scan_verdict',
  'version',
  'created_at',
  'started_at',
  'finished_at',
  'duration_s',
  'triggered_by',
  'url',
  'error',
] as const;

/**
 * CSV export of the runs, with the list's filters (`status`, `blocked`, `q`,
 * `applicationId`, `targetId`, `runtime`), newest first.
 *
 * The same permission as the list: the export shows nothing the screen would not
 * show. It is logged — it takes away the email addresses of those who triggered
 * the runs.
 */
export const GET = apiRoute(async (request) => {
  const auth = await requirePermission(request, 'deployment:read');
  const filter = readSearchParams(request, querySchema);

  let rows = 0;
  async function* chunks(): AsyncGenerator<string, void, undefined> {
    yield csvRow(COLUMNS);
    for await (const batch of iterateDeployments(filter, { limit: EXPORT_MAX_ROWS })) {
      // One batched read for the scans column, not one per row.
      const digest = await scanDigestForDeployments(batch.map((item) => item.id));
      let chunk = '';
      for (const item of batch) {
        const duration =
          item.startedAt && item.finishedAt
            ? Math.max(0, Math.round((item.finishedAt.getTime() - item.startedAt.getTime()) / 1000))
            : null;
        chunk += csvRow([
          item.number,
          item.applicationSlug,
          item.targetName,
          item.targetHost,
          item.runtime,
          item.status,
          item.failedStep,
          digest.get(item.id)?.verdict ?? null,
          item.version,
          item.createdAt.toISOString(),
          item.startedAt?.toISOString() ?? null,
          item.finishedAt?.toISOString() ?? null,
          duration,
          item.triggeredByEmail,
          item.url,
          item.error,
        ]);
      }
      rows += batch.length;
      yield chunk;
    }
  }

  const stamp = new Date().toISOString().slice(0, 10);

  return exportResponse({
    chunks: chunks(),
    contentType: 'text/csv; charset=utf-8',
    filename: `pupitre-runs-${stamp}.csv`,
    fallbackName: 'pupitre-runs.csv',
    context: { export: 'deployments' },
    onSettled: async (complete) => {
      await logAudit({
        actorId: auth.userId,
        action: 'deployment.list.exported',
        resourceType: 'deployment',
        after: {
          format: 'csv',
          filters: filter,
          rows,
          complete,
          truncated: rows >= EXPORT_MAX_ROWS,
        },
        ip: auth.ip,
      });
    },
  });
});
