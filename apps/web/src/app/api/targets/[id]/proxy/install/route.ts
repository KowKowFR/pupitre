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
import { currentLanguage } from '@/i18n/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  /** The proxy to install; Traefik for the clients from before the choice. */
  kind: proxyKindSchema.default('traefik'),
  /** What the detection offered for this proxy: `container`, `kubernetes`… */
  option: z.string().regex(/^[a-z0-9-]{1,32}$/),
  acme: acmeSettingsSchema,
});

/**
 * Installing a proxy — or setting K3s's. The connection is set right away as
 * `installing`: the screen sees it progress, and the job completes it
 * (configuration, name, test) or leaves it `failed` with the reason. The provider
 * refuses what the option cannot do (an authority it does not accept, for
 * instance), saying so.
 */
export const POST = apiRoute<Context>(async (request, context) => {
  const language = await currentLanguage();
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

  // A placeholder configuration, completed by the job.
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
  return NextResponse.json(
    { proxy: proxyViewForUi(proxy, language), jobId: job.id },
    { status: 202 },
  );
});
