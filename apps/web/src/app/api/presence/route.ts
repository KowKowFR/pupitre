import { PRESENCE_CHOICES } from '@pupitre/core';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requireTeamMember } from '@/lib/rbac';
import { presenceInput, setPresenceChoice } from '@/lib/realtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.union([
  /** A tab signals an interaction (keyboard, mouse, back to the foreground). */
  z.object({ input: z.literal(true) }),
  /** The "My status" menu: away or do not disturb, `null` for automatic. */
  z.object({ choice: z.enum(PRESENCE_CHOICES).nullable() }),
]);

/**
 * One's own presence, and only one's own. Nothing is logged: it is a state of a
 * few minutes, not an action.
 */
export const POST = apiRoute(async (request) => {
  const auth = await requireTeamMember(request);
  const body = await readJsonBody(request, bodySchema);
  const status =
    'input' in body
      ? await presenceInput(auth.userId)
      : await setPresenceChoice(auth.userId, body.choice);
  return NextResponse.json({ status });
});
