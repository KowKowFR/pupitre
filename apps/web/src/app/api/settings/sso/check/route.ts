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
 * « Tester » : le fournisseur répond-il à cette adresse, et s'annonce-t-il bien
 * comme cet émetteur ? Rien n'est enregistré — c'est la question qu'on se pose
 * avant d'enregistrer. Réservé à qui règle l'instance : le panel appelle une
 * adresse saisie, derrière la garde de sortie.
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
