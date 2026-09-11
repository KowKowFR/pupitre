import { getNotificationChannel, logAudit } from '@tp/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { runChannelTest } from '@/lib/notifications';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

/**
 * Envoie un message d'essai et **attend le verdict**.
 *
 * Ce bouton n'est pas un ornement : une configuration SMTP fausse ne se
 * découvre autrement qu'au premier incident, c'est-à-dire au pire moment. Une
 * réponse « c'est enfilé » ne dirait rien de ce qu'on veut savoir.
 *
 * L'arbitrage synchrone / file est détaillé dans `@/lib/notifications` : la
 * route enfile puis attend, sur le modèle de `/api/targets/[id]/metrics`, parce
 * que le panel n'a aucun transport SMTP et que le travail réel appartient au
 * worker.
 *
 * `settings:manage` et non `settings:read` : un essai fait *partir* un message
 * vers un tiers, avec les identifiants de l'instance. C'est une écriture vers
 * l'extérieur, pas une lecture.
 */
export const POST = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'settings:manage');
  const { id } = paramsSchema.parse(await context.params);

  const channel = await getNotificationChannel(id);
  if (!channel) throw new NotFoundError(`Canal « ${id} » introuvable`);

  const result = await runChannelTest(id, auth.userId, auth.ip);

  await logAudit({
    actorId: auth.userId,
    action: 'notification.channel.tested',
    resourceType: 'notification_channel',
    resourceId: id,
    after: {
      kind: result.kind,
      name: channel.name,
      probeOk: result.probe.ok,
      delivered: result.delivered,
      // Déjà expurgé par la couche d'envoi : aucun fragment de jeton ici.
      error: result.error,
    },
    ip: auth.ip,
  });

  return NextResponse.json({ ...result, name: channel.name });
});
