import { NextResponse } from 'next/server';
import { listDomains } from '@/lib/domains';
import { apiRoute } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Tous les domaines de l'instance : le proxy qui les sert, leur état, leur
 * certificat et le temps qu'il lui reste. `attention` dit ceux qui ne
 * répondent pas ou dont le certificat approche de son échéance — de quoi
 * brancher une vérification extérieure sans rien recalculer.
 */
export const GET = apiRoute(async (request) => {
  await requirePermission(request, 'application:read');
  return NextResponse.json({ items: await listDomains() });
});
