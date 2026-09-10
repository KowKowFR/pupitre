import { parseScanConfig } from '@tp/core';
import { getDeploymentSummary, listScanRuns } from '@tp/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

/** Exécutions de scan d'un déploiement, avec leurs compteurs par sévérité. */
export const GET = apiRoute<Context>(async (request, context) => {
  await requirePermission(request, 'scan:read');
  const { id } = paramsSchema.parse(await context.params);

  const deployment = await getDeploymentSummary(id);
  if (!deployment) throw new NotFoundError(`Déploiement « ${id} » introuvable`);

  return NextResponse.json({
    deploymentId: id,
    config: parseScanConfig(deployment.scanConfig),
    items: await listScanRuns(id),
  });
});
