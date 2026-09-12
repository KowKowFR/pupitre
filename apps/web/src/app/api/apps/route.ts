import { listSupervisedApps } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Les applications en marche — pas l'historique des déploiements.
 * Une par couple (application, cible) : c'est le dernier déploiement de chaque
 * couple qui tourne réellement.
 */
export const GET = apiRoute(async (request) => {
  await requirePermission(request, 'deployment:read');
  const items = await listSupervisedApps();
  return NextResponse.json({ items, total: items.length });
});
