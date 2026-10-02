import {
  PROXY_CHECK_JOB,
  PROXY_REMOVE_JOB,
  describeProxy,
  parseProxyConfig,
  proxyKindSchema,
} from '@pupitre/core';
import {
  countRoutesServedBy,
  getProxy,
  getProxyForTarget,
  getTarget,
  getTargetLink,
  listProxyLinks,
  listRoutes,
  listRemoteProxies,
  listTargetProxies,
  listTargets,
  logAudit,
  saveTargetProxy,
} from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { proxy as messages } from '@/i18n/messages/proxy';
import { ConflictError, HttpError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { linkViewForUi, proxyViewForUi, routeViewForUi } from '@/lib/proxy';
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

/**
 * Le proxy de la cible : le sien — avec les machines qu'il sert —, ou celui
 * d'une autre qui la sert. Plus les domaines qui passent par lui, et les
 * proxies des autres machines auxquels on pourrait la relier.
 */
export const GET = apiRoute<Context>(async (request, context) => {
  await requirePermission(request, 'target:read');
  const { id } = paramsSchema.parse(await context.params);
  const target = await targetOr404(id);
  const [proxy, link, all, remote, targets] = await Promise.all([
    getProxyForTarget(id),
    getTargetLink(id),
    listTargetProxies(),
    listRemoteProxies(),
    listTargets(),
  ]);
  const nameOf = new Map(targets.map((target) => [target.id, target.name]));

  // Les domaines servis : ceux de la machine, et ceux des machines reliées.
  const served = proxy ? await listProxyLinks(proxy.id) : [];
  const routes = (
    await Promise.all(
      [id, ...served.map((entry) => entry.targetId)].map((targetId) => listRoutes({ targetId })),
    )
  ).flat();
  const linkedProxy = link ? await getProxy(link.proxyId) : null;

  return NextResponse.json({
    proxy: proxy ? proxyViewForUi(proxy) : null,
    link:
      link && linkedProxy
        ? linkViewForUi(
            link,
            linkedProxy,
            nameOf.get(linkedProxy.hostTargetId ?? '') ?? linkedProxy.name,
          )
        : null,
    served: served.map((entry) => ({
      targetId: entry.targetId,
      targetName: entry.targetName,
      address: entry.address,
      status: entry.status,
    })),
    candidates: [
      ...[...all.entries()]
        .filter(([hostId, candidate]) => hostId !== id && candidate.status !== 'installing')
        .map(([hostId, candidate]) => ({
          proxyId: candidate.id,
          targetId: hostId as string | null,
          targetName: nameOf.get(hostId) ?? hostId,
          description: proxyViewForUi(candidate).description,
        }))
        .sort((a, b) => a.targetName.localeCompare(b.targetName)),
      // Les proxies distants, hors des cibles : à la suite.
      ...remote.map((candidate) => ({
        proxyId: candidate.id,
        targetId: null,
        targetName: candidate.name,
        description: proxyViewForUi(candidate).description,
      })),
    ],
    suggestedAddress: target.host,
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
  if (await getTargetLink(id)) throw new ConflictError(msg(messages, 'error.linked'));

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
  // Ses domaines, et ceux des machines qu'il sert par liaison.
  const count = await countRoutesServedBy(proxy.id);
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
