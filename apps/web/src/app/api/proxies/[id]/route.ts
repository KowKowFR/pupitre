import {
  PROXY_CHECK_JOB,
  parseProxyConfig,
  parseProxySecrets,
  proxyPlacement,
} from '@pupitre/core';
import {
  countRoutesServedBy,
  deleteProxy,
  getProxy,
  logAudit,
  updateRemoteProxy,
} from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { proxy as messages } from '@/i18n/messages/proxy';
import { ConflictError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { remoteProxyViewForUi, waitForProxyCheck } from '@/lib/proxy';
import { getOpsQueue } from '@/lib/queue';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

async function remoteOr404(id: string) {
  const proxy = await getProxy(id);
  if (!proxy || proxyPlacement(proxy.kind) !== 'remote') {
    throw new NotFoundError(msg(messages, 'error.proxyNotFound'));
  }
  return proxy;
}

const patchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  config: z.record(z.string(), z.unknown()),
  /** Absent: the previous credentials stay. */
  secrets: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Changing a remote connection — its address, its account. The test starts again
 * and the route returns its outcome: on failure, the connection stays failed, and
 * says so.
 */
export const PATCH = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'target:update');
  const { id } = paramsSchema.parse(await context.params);
  const before = await remoteOr404(id);
  const input = await readJsonBody(request, patchSchema);
  const config = parseProxyConfig(before.kind, input.config) as Record<string, unknown>;
  const secrets = input.secrets ? parseProxySecrets(before.kind, input.secrets) : undefined;

  await updateRemoteProxy(id, {
    ...(input.name ? { name: input.name } : {}),
    config,
    ...(secrets ? { secrets } : {}),
  });
  const job = await getOpsQueue().add(PROXY_CHECK_JOB, { proxyId: id }, { attempts: 1 });
  const check = await waitForProxyCheck(job);
  await logAudit({
    actorId: auth.userId,
    action: 'proxy.updated',
    resourceType: 'proxy',
    resourceId: id,
    before: { name: before.name, config: before.config },
    after: { name: input.name ?? before.name, config, credentialsChanged: Boolean(secrets) },
    ip: auth.ip,
  });
  const saved = await getProxy(id);
  return NextResponse.json({ proxy: saved ? remoteProxyViewForUi(saved) : null, check });
});

/**
 * Removing the connection. Refused as long as domains go through this proxy; the
 * machines it served without a domain are unlinked with it. Nothing is
 * uninstalled: Pupitre installed nothing.
 */
export const DELETE = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'target:update');
  const { id } = paramsSchema.parse(await context.params);
  const proxy = await remoteOr404(id);
  const count = await countRoutesServedBy(proxy.id);
  if (count > 0) throw new ConflictError(msg(messages, 'error.hasRoutes', { count }));
  await deleteProxy(proxy.id);
  await logAudit({
    actorId: auth.userId,
    action: 'proxy.removed',
    resourceType: 'proxy',
    resourceId: proxy.id,
    before: { kind: proxy.kind, name: proxy.name, config: proxy.config },
    ip: auth.ip,
  });
  return NextResponse.json({ removed: true });
});
