import { statusPageInputSchema } from '@pupitre/core';
import { NextResponse } from 'next/server';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { assertStatusMonitors, buildStatusPageModel } from '@/lib/status-page';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The editor's preview: the page as a visitor would read it, computed on the
 * **unsaved** blocks. Nothing is written; it is the same computation as the
 * public page, hence the same filter of what goes out.
 */
export const POST = apiRoute(async (request) => {
  await requirePermission(request, 'status_page:manage');
  const input = await readJsonBody(request, statusPageInputSchema);
  await assertStatusMonitors(input.blocks);
  return NextResponse.json(await buildStatusPageModel(input));
});
