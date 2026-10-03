import { statusPageInputSchema } from '@pupitre/core';
import { NextResponse } from 'next/server';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { assertStatusMonitors, buildStatusPageModel } from '@/lib/status-page';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * L'aperçu de l'éditeur : la page telle qu'un visiteur la lirait, calculée
 * sur les blocs **non enregistrés**. Rien n'est écrit ; c'est le même calcul
 * que la page publique, donc le même filtre de ce qui sort.
 */
export const POST = apiRoute(async (request) => {
  await requirePermission(request, 'status_page:manage');
  const input = await readJsonBody(request, statusPageInputSchema);
  await assertStatusMonitors(input.blocks);
  return NextResponse.json(await buildStatusPageModel(input));
});
