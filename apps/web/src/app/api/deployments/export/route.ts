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

/** Les filtres de la liste, sans sa pagination : l'export prend toutes les pages. */
const querySchema = deploymentQuerySchema.omit({ page: true, pageSize: true });

/**
 * Plafond d'un export. Une instance en est très loin ; la borne existe pour
 * qu'aucune requête HTTP ne puisse devenir une opération longue (règle 2).
 * Atteinte, elle est dite au journal d'activité (`truncated`).
 */
const EXPORT_MAX_ROWS = 50_000;

/**
 * Colonnes du fichier. Des noms techniques, stables, et non des libellés
 * traduits : un export se relit par un script ou un tableur des mois plus tard,
 * quelle que soit la langue réglée entre-temps. Les dates sont en ISO 8601 UTC.
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
 * Export CSV des runs, avec les filtres de la liste (`status`, `blocked`, `q`,
 * `applicationId`, `targetId`, `runtime`), du plus récent au plus ancien.
 *
 * Même permission que la liste : l'export ne montre rien que l'écran ne
 * montrerait pas. Il est journalisé — il emporte les adresses e-mail de ceux
 * qui ont déclenché les runs.
 */
export const GET = apiRoute(async (request) => {
  const auth = await requirePermission(request, 'deployment:read');
  const filter = readSearchParams(request, querySchema);

  let rows = 0;
  async function* chunks(): AsyncGenerator<string, void, undefined> {
    yield csvRow(COLUMNS);
    for await (const batch of iterateDeployments(filter, { limit: EXPORT_MAX_ROWS })) {
      // Une lecture par lot pour la colonne des scans, pas une par ligne.
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
