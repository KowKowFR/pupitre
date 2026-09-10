import { SCANNERS } from '@tp/core';
import { getScanRun, getScanRunRaw } from '@tp/db';
import { z } from 'zod';
import { ConflictError, NotFoundError } from '@/lib/errors';
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
  if (!run) throw new NotFoundError(`Scan « ${id} » introuvable`);

  const descriptor = SCANNERS[run.scanner];
  if (descriptor.kind !== 'sbom' || descriptor.sbomFormat === null) {
    throw new ConflictError(`« ${descriptor.label} » ne produit pas de SBOM.`);
  }
  if (run.status !== 'success') {
    throw new ConflictError(
      `Le scan « ${descriptor.label} » n'a pas abouti : aucun SBOM à télécharger.`,
    );
  }

  const stored = await getScanRunRaw(id);
  if (!stored || stored.raw === null) {
    throw new NotFoundError('Aucun SBOM enregistré pour ce scan.');
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
