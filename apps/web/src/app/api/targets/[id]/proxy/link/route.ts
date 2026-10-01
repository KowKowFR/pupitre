import { PROXY_LINK_CHECK_JOB, isIPv4, parseProxyConfig } from '@pupitre/core';
import {
  deleteTargetLink,
  getProxy,
  getProxyForTarget,
  getTarget,
  getTargetLink,
  listRoutes,
  logAudit,
  saveTargetLink,
} from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { proxy as messages } from '@/i18n/messages/proxy';
import { ConflictError, HttpError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { getOpsQueue } from '@/lib/queue';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

const putSchema = z.object({
  proxyId: z.string().uuid(),
  /** Comment la machine du proxy joint celle-ci — de préférence une adresse privée. */
  address: z.string().trim().min(1).max(255),
});

/**
 * Relier cette machine au reverse proxy d'une autre — le proxy central. Ses
 * domaines seront posés là-bas, vers son adresse. Un test de la liaison part
 * aussitôt : il relève par quelle adresse le proxy arrive, et si l'adresse
 * donnée est bien à cette machine.
 */
export const PUT = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'target:update');
  const { id } = paramsSchema.parse(await context.params);
  const target = await getTarget(id);
  if (!target) throw new NotFoundError(msg(messages, 'error.targetNotFound'));
  const input = await readJsonBody(request, putSchema);

  if (await getProxyForTarget(id)) throw new ConflictError(msg(messages, 'error.hasOwnProxy'));
  const proxy = await getProxy(input.proxyId);
  if (!proxy?.hostTargetId) throw new NotFoundError(msg(messages, 'error.proxyNotFound'));
  if (proxy.hostTargetId === id) throw new ConflictError(msg(messages, 'error.hasOwnProxy'));
  if (proxy.status === 'installing') throw new ConflictError(msg(messages, 'error.installing'));
  const config = parseProxyConfig(proxy.kind, proxy.config);
  if (config.mode === 'kubernetes' && !isIPv4(input.address)) {
    // Le Traefik d'un cluster joint une autre machine par une EndpointSlice : une IPv4.
    throw new HttpError(422, 'link_needs_ipv4', msg(messages, 'error.linkNeedsIp'));
  }

  const before = await getTargetLink(id);
  await saveTargetLink({
    targetId: id,
    proxyId: proxy.id,
    address: input.address,
    createdBy: auth.userId,
  });
  const job = await getOpsQueue().add(PROXY_LINK_CHECK_JOB, { targetId: id });
  if (!job.id) throw new HttpError(500, 'enqueue_failed', msg(messages, 'error.jobNoId'));
  const host = await getTarget(proxy.hostTargetId);
  await logAudit({
    actorId: auth.userId,
    action: 'proxy.linked',
    resourceType: 'target',
    resourceId: id,
    before: before ? { proxyId: before.proxyId, address: before.address } : null,
    after: { proxyId: proxy.id, via: host?.name ?? proxy.hostTargetId, address: input.address },
    ip: auth.ip,
  });
  return NextResponse.json({ jobId: job.id });
});

/** Délier — refusé tant que des domaines de cette machine passent par ce proxy. */
export const DELETE = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'target:update');
  const { id } = paramsSchema.parse(await context.params);
  const link = await getTargetLink(id);
  if (!link) return NextResponse.json({ removed: false });
  const routes = await listRoutes({ targetId: id });
  if (routes.length > 0) {
    throw new ConflictError(msg(messages, 'error.hasRoutes', { count: routes.length }));
  }
  await deleteTargetLink(id);
  await logAudit({
    actorId: auth.userId,
    action: 'proxy.unlinked',
    resourceType: 'target',
    resourceId: id,
    before: { proxyId: link.proxyId, address: link.address },
    ip: auth.ip,
  });
  return NextResponse.json({ removed: true });
});
