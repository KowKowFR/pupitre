import { IMAGE_CHECK_JOB, imageCheckJobDataSchema } from '@pupitre/core';
import { getApplication } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { applications as messages } from '@/i18n/messages/applications';
import { HttpError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { enforceRateLimit, type RateLimitRule } from '@/lib/rate-limit';
import { requirePermission } from '@/lib/rbac';
import { getSupervisionQueue } from '@/lib/supervision-queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

/** Les registres publics comptent les requêtes : pas de rafale depuis un bouton. */
const CHECK_RULE: RateLimitRule = { name: 'images:check', limit: 6, windowSec: 60 };

/**
 * « Vérifier maintenant » : la même tâche que la vérification planifiée,
 * restreinte à cette application. Par la file — une vérification ouvre une
 * session SSH par cible et interroge des registres. Le résultat revient par le
 * signal temps réel `applications`, qui rafraîchit la fiche.
 */
export const POST = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'application:read');
  await enforceRateLimit(CHECK_RULE, auth.userId);
  const { id } = paramsSchema.parse(await context.params);

  const application = await getApplication(id);
  if (!application) throw new NotFoundError(msg(messages, 'error.notFound', { id }));

  const data = imageCheckJobDataSchema.parse({
    applicationId: id,
    actorId: auth.userId,
    ip: auth.ip,
  });
  // Un identifiant par application : deux clics rapprochés ne font qu'une tâche.
  const job = await getSupervisionQueue().add(IMAGE_CHECK_JOB, data, {
    jobId: `images-check-${id}-${Math.floor(Date.now() / 10_000)}`,
    attempts: 1,
    removeOnComplete: { age: 3600, count: 100 },
    removeOnFail: { age: 24 * 3600, count: 100 },
  });
  if (!job.id) throw new HttpError(500, 'enqueue_failed', msg(messages, 'error.jobNoId'));

  return NextResponse.json({ jobId: job.id, state: 'queued' }, { status: 202 });
});
