import { logAudit } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { listAccountSessions } from '@/lib/account-sessions';
import { getAuth } from '@/lib/auth';
import { apiRoute } from '@/lib/http';
import { requireSession } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Ferme toutes les sessions de l'appelant **sauf** celle de la requête. Les
 * autres appareils reviennent à l'écran de connexion à leur prochain appel.
 *
 * Le décompte est pris avant la fermeture : il dit au journal combien
 * d'appareils ont été déconnectés, et il permet de ne rien écrire quand il
 * n'y avait rien à fermer.
 */
export const POST = apiRoute(async (request) => {
  const auth = await requireSession(request);

  const { sessions } = await listAccountSessions(request.headers);
  const others = sessions.filter((session) => !session.current);
  if (others.length === 0) return NextResponse.json({ revoked: 0 });

  await getAuth().api.revokeOtherSessions({ headers: request.headers });

  await logAudit({
    actorId: auth.userId,
    action: 'account.sessions.revoked_others',
    resourceType: 'user',
    resourceId: auth.userId,
    before: {
      sessions: others.map((session) => ({ device: session.device, ip: session.ipAddress })),
    },
    after: { revoked: others.length },
    ip: auth.ip,
  });

  return NextResponse.json({ revoked: others.length });
});
