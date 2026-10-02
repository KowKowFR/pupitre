import { listApiTokens } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { toApiTokenDto } from '@/lib/api-tokens';
import { apiRoute } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Tous les jetons d'API de l'instance, avec leur auteur — pour savoir ce qui
 * peut agir sans navigateur, et le couper. Depuis le panel seulement.
 */
export const GET = apiRoute(async (request) => {
  await requirePermission(request, 'user:read', { sessionOnly: true });
  const items = await listApiTokens();
  return NextResponse.json({ items: items.map(toApiTokenDto) });
});
