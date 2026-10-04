import { listApplications, listChatMembers, listTargets } from '@pupitre/db';
import { NextResponse } from 'next/server';
import type { DirectoryEntry } from '@/lib/chat';
import { apiRoute } from '@/lib/http';
import { requireTeamMember } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * What the session can mention: all the people, the machines if it reads the
 * targets, the applications if it reads the applications. It is also what gives
 * the displayed mentions their current name.
 */
export const GET = apiRoute(async (request) => {
  const auth = await requireTeamMember(request);
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
