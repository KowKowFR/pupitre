import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { settings as messages } from '@/i18n/messages/settings';
import { getT } from '@/i18n/server';
import { checkDiscovery } from '@/lib/sso';
import { describeSsoProblem } from '@/lib/sso-problem';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({ issuer: z.string().trim().url().max(300) });

/**
 * "Test": does the provider answer at this address, and does it announce itself
 * as this issuer? Nothing is saved — it is the question one asks before saving.
 * Reserved to whoever sets the instance: the panel calls a typed address, behind
 * the egress guard.
 */
export const POST = apiRoute(async (request) => {
  await requirePermission(request, 'settings:manage', { sessionOnly: true });
  const { issuer } = await readJsonBody(request, bodySchema);
  const result = await checkDiscovery(issuer);
  return NextResponse.json(
    result.ok
      ? result
      : { ok: false, error: describeSsoProblem(result.problem, await getT(messages)) },
  );
});
