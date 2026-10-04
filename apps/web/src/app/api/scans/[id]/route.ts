import { matchingAcceptance } from '@pupitre/core';
import {
  findingQuerySchema,
  getScanRun,
  listFindings,
  listVulnerabilityAcceptances,
} from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { deployments as messages } from '@/i18n/messages/deployments';
import { NotFoundError, msg } from '@/lib/errors';
import { apiRoute, readSearchParams } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

/**
 * A run's detail: paginated findings, filterable by severity and by view (`view`:
 * `all`, `fixable`, `unfixable`, `accepted`). Each finding says whether it is
 * covered, today, by an acceptance of the application.
 */
export const GET = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'scan:read');
  const { id } = paramsSchema.parse(await context.params);
  const query = readSearchParams(request, findingQuerySchema);

  const run = await getScanRun(id);
  if (!run) throw new NotFoundError(msg(messages, 'error.scanNotFound', { id }));

  const [page, acceptances] = await Promise.all([
    listFindings(id, query),
    listVulnerabilityAcceptances(run.applicationId),
  ]);
  const now = new Date();
  return NextResponse.json({
    ...run,
    canAccept: auth.can('scan:configure'),
    findings: {
      ...page,
      items: page.items.map((finding) => {
        const acceptance = matchingAcceptance(finding, acceptances, now);
        return {
          ...finding,
          acceptance: acceptance
            ? {
                id: acceptance.id,
                package: acceptance.package,
                reason: acceptance.reason,
                expiresAt: acceptance.expiresAt?.toISOString() ?? null,
                authorName: acceptance.authorName,
              }
            : null,
        };
      }),
    },
  });
});
