import { appSpecJsonSchema } from '@pupitre/core/ai';
import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/http';
import { requireCaller } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The AppSpec's JSON Schema — what an editor, a CI or an agent needs to write a
 * `pupitre.json` without guessing.
 *
 * It is the **shape**: the cross-field rules (one exposed service, no
 * `dependsOn` cycle, secret aliases that resolve) are not expressible in it.
 * `POST /api/appspec/validate` applies them all.
 */
export const GET = apiRoute(async (request) => {
  await requireCaller(request);
  return NextResponse.json(appSpecJsonSchema());
});
