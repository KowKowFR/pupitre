import { SCANNERS } from '@pupitre/core';
import { getScanRun, getScanRunRaw } from '@pupitre/db';
import { z } from 'zod';
import { deployments as messages } from '@/i18n/messages/deployments';
import { ConflictError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

/**
 * Downloading the SBOM.
 *
 * The document is the tool's raw output: it lives in `scan_runs.raw`, without a
 * dedicated column that would duplicate it. What decides that a scan produces
 * one is its `kind` — data of `SCANNERS`, not a test on its name.
 */
export const GET = apiRoute<Context>(async (request, context) => {
  await requirePermission(request, 'scan:read');
  const { id } = paramsSchema.parse(await context.params);

  const run = await getScanRun(id);
  if (!run) throw new NotFoundError(msg(messages, 'error.scanNotFound', { id }));

  const descriptor = SCANNERS[run.scanner];
  if (descriptor.kind !== 'sbom' || descriptor.sbomFormat === null) {
    throw new ConflictError(msg(messages, 'error.sbomUnsupported', { scanner: descriptor.label }));
  }
  if (run.status !== 'success') {
    throw new ConflictError(
      msg(messages, 'error.sbomIncomplete', { scanner: descriptor.label }),
    );
  }

  const stored = await getScanRunRaw(id);
  if (!stored || stored.raw === null) {
    throw new NotFoundError(msg(messages, 'error.sbomMissing'));
  }

  const filename =
    `${run.applicationSlug}-v${run.deploymentId.slice(0, 8)}-${run.scanner}.` +
    `${descriptor.sbomExtension ?? 'json'}`;

  return new Response(JSON.stringify(stored.raw, null, 2), {
    status: 200,
    headers: {
      'content-type': `${descriptor.mediaType}; charset=utf-8`,
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  });
});
