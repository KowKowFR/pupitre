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
 * Téléchargement du SBOM.
 *
 * Le document est la sortie brute de l'outil : il vit dans `scan_runs.raw`,
 * sans colonne dédiée qui le dupliquerait. Ce qui décide qu'un scan en produit
 * un, c'est son `kind` — une donnée de `SCANNERS`, pas un test sur son nom.
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
