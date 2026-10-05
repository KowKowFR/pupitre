import { PURGE_MAX_ROWS, logAudit, purgeDeployments, purgeFilterSchema } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { currentLanguage } from '@/i18n/server';
import { apiRoute, readJsonBody } from '@/lib/http';
import { logger } from '@/lib/logger';
import { requirePermission } from '@/lib/rbac';
import { purgeAuditPayload } from '../purge-audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Bulk purge of the history.
 *
 * Purging is not destroying: nothing is touched on the target machine, only the
 * trace in the database disappears. The guardrail — a deployment in service is
 * not purged — lives in `purgeDeployments()`, not here.
 *
 * A single route for the preview and the execution, told apart by `dryRun`. A
 * `GET` with the same filters would have required encoding an array of
 * identifiers in the query string, and above all maintaining two decision paths
 * where the screen needs the opposite guarantee: the count announced in the
 * confirmation is *exactly* the one that will be applied.
 */
const purgeRequestSchema = z.intersection(
  purgeFilterSchema,
  z.object({ dryRun: z.boolean().default(false) }),
);

export const POST = apiRoute(async (request) => {
  const auth = await requirePermission(request, 'deployment:purge');
  const { dryRun, ...filter } = await readJsonBody(request, purgeRequestSchema);

  // The refusals are shown as is: in the language of whoever reads them.
  const report = await purgeDeployments(filter, { dryRun, language: await currentLanguage() });

  // A preview changed nothing: it has nothing to log.
  if (!dryRun && report.purgedCount > 0) {
    await logAudit({
      actorId: auth.userId,
      action: 'deployment.purged',
      resourceType: 'deployment',
      resourceId: null,
      after: purgeAuditPayload(report, filter),
      ip: auth.ip,
    });

    logger.info(
      { purged: report.purgedCount, refused: report.refusedCount, actorId: auth.userId },
      'deployments history purged',
    );
  }

  // The cap is part of the contract: a client that sees `truncated` knows it has
  // rows left and that it must call the route again.
  return NextResponse.json({ ...report, limit: PURGE_MAX_ROWS });
});
