import { PRESENCE_CHOICES } from '@pupitre/core';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requireSession } from '@/lib/rbac';
import { presenceInput, setPresenceChoice } from '@/lib/realtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.union([
  /** Un onglet signale une interaction (clavier, souris, retour au premier plan). */
  z.object({ input: z.literal(true) }),
  /** Le menu « Mon statut » : absent ou ne pas déranger, `null` pour automatique. */
  z.object({ choice: z.enum(PRESENCE_CHOICES).nullable() }),
]);

/**
 * Sa propre présence, et seulement la sienne. Rien n'est journalisé : c'est
 * un état de quelques minutes, pas une action.
 */
export const POST = apiRoute(async (request) => {
  const auth = await requireSession(request);
  const body = await readJsonBody(request, bodySchema);
  const status =
    'input' in body
      ? await presenceInput(auth.userId)
      : await setPresenceChoice(auth.userId, body.choice);
  return NextResponse.json({ status });
});
