import { PROXY_INSTALL_JOB, acmeSettingsSchema } from '@pupitre/core';
import { getProxyForTarget, getTarget, logAudit, saveTargetProxy } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { proxy as messages } from '@/i18n/messages/proxy';
import { ConflictError, HttpError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { proxyViewForUi } from '@/lib/proxy';
import { getOpsQueue } from '@/lib/queue';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  /** Ce que la détection a proposé : `container`, `kubernetes`. */
  option: z.enum(['container', 'kubernetes']),
  acme: acmeSettingsSchema,
});

/**
 * Installer Traefik — ou régler celui de K3s. La connexion est posée tout de
 * suite en `installing` : l'écran la voit avancer, et la tâche la complète
 * (configuration, test) ou la laisse en `failed` avec la raison.
 */
export const POST = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'target:update');
  const { id } = paramsSchema.parse(await context.params);
  const target = await getTarget(id);
  if (!target) throw new NotFoundError(msg(messages, 'error.targetNotFound'));
  const input = await readJsonBody(request, bodySchema);
  if (input.acme.server === 'custom' && !input.acme.customUrl) {
    throw new HttpError(422, 'acme_url_missing', msg(messages, 'error.acmeUrl'));
  }
  const existing = await getProxyForTarget(id);
  if (existing?.status === 'installing') throw new ConflictError(msg(messages, 'error.installing'));

  // Une configuration d'attente, complétée par la tâche : le mode suffit à la lire.
  const proxy = await saveTargetProxy({
    targetId: id,
    kind: 'traefik',
    name: input.option === 'kubernetes' ? 'Traefik (K3s)' : 'Traefik',
    config: { mode: input.option === 'kubernetes' ? 'kubernetes' : 'file' },
    managed: true,
    status: 'installing',
    createdBy: auth.userId,
  });
  const job = await getOpsQueue().add(PROXY_INSTALL_JOB, {
    targetId: id,
    proxyId: proxy.id,
    option: input.option,
    acme: input.acme,
    actorId: auth.userId,
    ip: auth.ip,
  });
  if (!job.id) throw new HttpError(500, 'enqueue_failed', msg(messages, 'error.jobNoId'));
  await logAudit({
    actorId: auth.userId,
    action: 'proxy.install.requested',
    resourceType: 'target',
    resourceId: id,
    after: {
      proxyId: proxy.id,
      target: target.name,
      option: input.option,
      acmeServer: input.acme.server,
    },
    ip: auth.ip,
  });
  return NextResponse.json({ proxy: proxyViewForUi(proxy), jobId: job.id }, { status: 202 });
});
