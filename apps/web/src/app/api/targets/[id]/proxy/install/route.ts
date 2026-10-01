import {
  PROXY_INSTALL_JOB,
  acmeSettingsSchema,
  proxyKindLabel,
  proxyKindSchema,
} from '@pupitre/core';
import {
  getProxyForTarget,
  getTarget,
  getTargetLink,
  logAudit,
  saveTargetProxy,
} from '@pupitre/db';
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
  /** Le proxy à installer ; Traefik pour les clients d'avant le choix. */
  kind: proxyKindSchema.default('traefik'),
  /** Ce que la détection a proposé pour ce proxy : `container`, `kubernetes`… */
  option: z.string().regex(/^[a-z0-9-]{1,32}$/),
  acme: acmeSettingsSchema,
});

/**
 * Installer un proxy — ou régler celui de K3s. La connexion est posée tout de
 * suite en `installing` : l'écran la voit avancer, et la tâche la complète
 * (configuration, nom, test) ou la laisse en `failed` avec la raison. Le
 * provider refuse ce que l'option ne sait pas faire (une autorité qu'il
 * n'accepte pas, par exemple), en le disant.
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
  if (await getTargetLink(id)) throw new ConflictError(msg(messages, 'error.linked'));

  // Une configuration d'attente, complétée par la tâche.
  const proxy = await saveTargetProxy({
    targetId: id,
    kind: input.kind,
    name: proxyKindLabel(input.kind),
    config: {},
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
      kind: input.kind,
      option: input.option,
      acmeServer: input.acme.server,
    },
    ip: auth.ip,
  });
  return NextResponse.json({ proxy: proxyViewForUi(proxy), jobId: job.id }, { status: 202 });
});
