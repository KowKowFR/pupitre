import {
  HOST_SAMPLE_INTERVAL_SECONDS,
  HOST_SAMPLE_RETENTION_DAYS,
  getTarget,
  listOpenBreaches,
  resolveThresholds,
  targetHistories,
} from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { targets as messages } from '@/i18n/messages/targets';
import { NotFoundError, msg } from '@/lib/errors';
import { apiRoute, readSearchParams } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

const querySchema = z.object({
  /** Fenêtre, en heures. Bornée par la rétention : demander plus serait mentir. */
  hours: z.coerce
    .number()
    .int()
    .min(1)
    .max(HOST_SAMPLE_RETENTION_DAYS * 24)
    .default(24),
  /** Points rendus. Une courbe de 120 pixels n'a pas besoin de 2 000 valeurs. */
  buckets: z.coerce.number().int().min(12).max(240).default(48),
});

/**
 * L'historique d'une machine — la mémoire que le relevé n'avait pas.
 *
 * ── Pourquoi cette route ne passe **pas** par la file ───────────────────────
 * `GET /api/targets/[id]/metrics` enfile une tâche parce que la réponse exige
 * une session SSH, et que le panel n'en ouvre jamais. Ici, il n'y a pas de
 * machine à joindre : la réponse est en base, écrite par le balayage. C'est une
 * requête SQL, elle se fait dans la route comme n'importe quelle lecture.
 *
 * Conséquence directe, et c'est tout l'intérêt : **cet historique répond même
 * quand la machine est éteinte.** Le relevé instantané, lui, rend
 * `reachable:false`. L'écran affiche donc « injoignable » *et* la courbe des
 * dernières 24 h, ce qui est exactement le moment où on veut la voir.
 *
 * `target:read` suffit — la même permission que le relevé instantané, pour la
 * même donnée, prise il y a cinq minutes plutôt qu'à l'instant.
 */
export const GET = apiRoute<Context>(async (request, context) => {
  await requirePermission(request, 'target:read');
  const { id } = paramsSchema.parse(await context.params);
  const query = readSearchParams(request, querySchema);

  const target = await getTarget(id);
  if (!target) throw new NotFoundError(msg(messages, 'error.notFound', { id }));

  const [histories, thresholds, breaches] = await Promise.all([
    targetHistories([id], query.hours, query.buckets),
    resolveThresholds(id),
    // Seuls les dépassements **en cours** : la bannière de l'écran annonce un
    // problème présent. La chronologie des épisodes refermés se lit dans le
    // journal d'activité, qui est déjà l'écran fait pour ça.
    listOpenBreaches([id]),
  ]);

  const history = histories.get(id);

  return NextResponse.json({
    targetId: id,
    targetName: target.name,
    // La cadence est rendue avec la fenêtre : « 12 relevés sur 24 h » n'a pas
    // le même sens selon qu'on en attendait 288 ou 12.
    intervalSeconds: HOST_SAMPLE_INTERVAL_SECONDS,
    retentionDays: HOST_SAMPLE_RETENTION_DAYS,
    ...history,
    thresholds,
    breaches,
  });
});
