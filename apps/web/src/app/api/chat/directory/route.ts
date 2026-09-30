import { listApplications, listChatMembers, listTargets } from '@pupitre/db';
import { NextResponse } from 'next/server';
import type { DirectoryEntry } from '@/lib/chat';
import { apiRoute } from '@/lib/http';
import { requireSession } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Ce que la session peut mentionner : toutes les personnes, les machines si
 * elle lit les cibles, les applications si elle lit les applications. C'est
 * aussi ce qui donne leur nom actuel aux mentions affichées.
 */
export const GET = apiRoute(async (request) => {
  const auth = await requireSession(request);
  const [members, targets, applications] = await Promise.all([
    listChatMembers(),
    auth.can('target:read') ? listTargets() : Promise.resolve([]),
    auth.can('application:read') ? listApplications() : Promise.resolve([]),
  ]);
  const items: DirectoryEntry[] = [
    ...members.map((member) => ({
      kind: 'user' as const,
      id: member.id,
      label: member.name,
      hint: member.email,
    })),
    ...targets.map((target) => ({
      kind: 'target' as const,
      id: target.id,
      label: target.name,
      hint: target.host,
    })),
    ...applications.map((application) => ({
      kind: 'app' as const,
      id: application.id,
      label: application.slug,
      hint: application.description,
    })),
  ];
  return NextResponse.json({ items });
});
