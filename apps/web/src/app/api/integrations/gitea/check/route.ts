import { SourceProviderError } from '@pupitre/core';
import { fetchGiteaAccount } from '@pupitre/core/sources';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  url: z.string().trim().url().max(500),
  token: z.string().trim().min(8).max(500),
});

/**
 * « Tester » : la forge répond-elle, et à quel compte ouvre le jeton ? Rien
 * n'est enregistré. Un refus de la forge n'est pas une erreur de la route :
 * il revient dans `{ ok: false, error }`, pour être dit sur l'écran.
 */
export const POST = apiRoute(async (request) => {
  await requirePermission(request, 'settings:manage');
  const input = await readJsonBody(request, bodySchema);
  try {
    const account = await fetchGiteaAccount({ baseUrl: input.url, token: input.token });
    return NextResponse.json({ ok: true, ...account });
  } catch (error) {
    if (error instanceof SourceProviderError) {
      return NextResponse.json({ ok: false, error: error.message, status: error.status });
    }
    throw error;
  }
});
