import { CHAT_DEFAULT_CHANNEL } from '@pupitre/core';
import { markChatRead } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requireTeamMember } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Pas dans le futur : un marqueur en avance masquerait les messages suivants. */
const bodySchema = z.object({ at: z.coerce.date() });

/** « J'ai lu jusqu'ici. » Le marqueur n'avance jamais en arrière. */
export const POST = apiRoute(async (request) => {
  const auth = await requireTeamMember(request);
  const { at } = await readJsonBody(request, bodySchema);
  const now = new Date();
  await markChatRead(auth.userId, CHAT_DEFAULT_CHANNEL, at > now ? now : at);
  return new NextResponse(null, { status: 204 });
});
