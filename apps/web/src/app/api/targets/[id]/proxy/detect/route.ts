import { PROXY_DETECT_JOB } from '@pupitre/core';
import { getTarget } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { proxy as messages } from '@/i18n/messages/proxy';
import { HttpError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { opsQueueEvents } from '@/lib/proxy';
import { getOpsQueue } from '@/lib/queue';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

/**
 * Regarder la machine : les proxies déjà là, et ce que Pupitre pourrait y
 * installer. Le panel n'ouvre aucune session SSH — la question passe par le
 * worker, et la route attend sa réponse, comme pour les métriques d'hôte.
 *
 * 60 secondes : quelques commandes SSH (une par conteneur trouvé), plus
 * l'attente en file derrière un déploiement en cours. Au-delà, un 504 franc.
 */
const DETECT_TIMEOUT_MS = 60_000;

export const POST = apiRoute<Context>(async (request, context) => {
  await requirePermission(request, 'target:update');
  const { id } = paramsSchema.parse(await context.params);
  if (!(await getTarget(id))) throw new NotFoundError(msg(messages, 'error.targetNotFound'));

  const job = await getOpsQueue().add(PROXY_DETECT_JOB, { targetId: id }, { attempts: 1 });
  try {
    const result: unknown = await job.waitUntilFinished(opsQueueEvents(), DETECT_TIMEOUT_MS);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/timed out/i.test(message)) {
      throw new HttpError(504, 'proxy_detect_timeout', msg(messages, 'error.detectTimeout'));
    }
    throw new HttpError(
      502,
      'proxy_detect_failed',
      msg(messages, 'error.detectFailed', { error: message }),
    );
  }
});
