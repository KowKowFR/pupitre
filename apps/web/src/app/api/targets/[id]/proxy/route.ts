import {
  PROXY_CHECK_JOB,
  PROXY_REMOVE_JOB,
  describeProxy,
  parseProxyConfig,
  proxyKindSchema,
} from '@pupitre/core';
import {
  countRoutesByTarget,
  getProxyForTarget,
  getTarget,
  listRoutes,
  logAudit,
  saveTargetProxy,
} from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { proxy as messages } from '@/i18n/messages/proxy';
import { ConflictError, HttpError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { proxyViewForUi, routeViewForUi } from '@/lib/proxy';
import { getOpsQueue } from '@/lib/queue';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

async function targetOr404(id: string) {
  const target = await getTarget(id);
  if (!target) throw new NotFoundError(msg(messages, 'error.targetNotFound'));
  return target;
}

/** Le proxy de la cible, et les domaines qui passent par lui. */
export const GET = apiRoute<Context>(async (request, context) => {
  await requirePermission(request, 'target:read');
  const { id } = paramsSchema.parse(await context.params);
  await targetOr404(id);
  const [proxy, routes] = await Promise.all([getProxyForTarget(id), listRoutes({ targetId: id })]);
  return NextResponse.json({
    proxy: proxy ? proxyViewForUi(proxy) : null,
    routes: routes.map(routeViewForUi),
  });
});

const putSchema = z.object({
  kind: proxyKindSchema,
  name: z.string().trim().min(1).max(80).optional(),
  config: z.record(z.string(), z.unknown()),
});

/**
 * Brancher un proxy **trouvé** sur la machine : sa configuration, relue et
 * confirmée par l'utilisateur. Rien n'est installé — un test part aussitôt.
 */
export const PUT = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'target:update');
  const { id } = paramsSchema.parse(await context.params);
  const target = await targetOr404(id);
  const input = await readJsonBody(request, putSchema);
  const existing = await getProxyForTarget(id);
  if (existing?.status === 'installing') throw new ConflictError(msg(messages, 'error.installing'));

  let config: Record<string, unknown>;
  try {
    config = parseProxyConfig(input.kind, input.config) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof z.ZodError) throw error;
    throw new ConflictError(msg(messages, 'error.unknownKind'));
  }
  const saved = await saveTargetProxy({
    targetId: id,
    kind: input.kind,
    name: input.name ?? describeProxy(input.kind, config).split(' · ')[0] ?? input.kind,
    config,
    // Un proxy trouvé n'appartient pas à Pupitre : il ne le désinstallera jamais.
    managed: false,
    status: 'unknown',
    createdBy: auth.userId,
  });
  const job = await getOpsQueue().add(PROXY_CHECK_JOB, { proxyId: saved.id });
  if (!job.id) throw new HttpError(500, 'enqueue_failed', msg(messages, 'error.jobNoId'));
  await logAudit({
    actorId: auth.userId,
    action: 'proxy.connected',
    resourceType: 'target',
    resourceId: id,
    after: { proxyId: saved.id, kind: input.kind, target: target.name, config },
    ip: auth.ip,
  });
  return NextResponse.json({ proxy: proxyViewForUi(saved), jobId: job.id });
});

const deleteQuerySchema = z.object({ uninstall: z.enum(['0', '1']).default('0') });

/**
 * Retirer le proxy de la cible. Refusé tant que des domaines passent par lui :
 * les couper sans le dire laisserait des sites injoignables. `uninstall=1`
 * défait aussi ce que Pupitre a installé.
 */
export const DELETE = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'target:update');
  const { id } = paramsSchema.parse(await context.params);
  await targetOr404(id);
  const { uninstall } = deleteQuerySchema.parse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  const proxy = await getProxyForTarget(id);
  if (!proxy) return NextResponse.json({ removed: false });
  const count = await countRoutesByTarget(id);
  if (count > 0) throw new ConflictError(msg(messages, 'error.hasRoutes', { count }));
  const job = await getOpsQueue().add(PROXY_REMOVE_JOB, {
    proxyId: proxy.id,
    uninstall: uninstall === '1',
    actorId: auth.userId,
    ip: auth.ip,
  });
  if (!job.id) throw new HttpError(500, 'enqueue_failed', msg(messages, 'error.jobNoId'));
  return NextResponse.json({ jobId: job.id }, { status: 202 });
});
