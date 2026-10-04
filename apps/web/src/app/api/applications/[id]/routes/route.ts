import { PROXY_APPLY_JOB, proxyCapabilities, routeListSchema } from '@pupitre/core';
import {
  getApplication,
  getTarget,
  listLiveDeployments,
  listRoutes,
  listServingProxies,
  listTargets,
  resolveServingProxy,
  logAudit,
  replaceRoutes,
  RouteTakenError,
} from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { proxy as messages } from '@/i18n/messages/proxy';
import { ConflictError, HttpError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { assertServable, proxyViewForUi, routeViewForUi } from '@/lib/proxy';
import { getOpsQueue } from '@/lib/queue';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

/**
 * An application's domains, target by target: where it runs, and where it has
 * domains without running. With, for each target, what its proxy can do — the
 * screen only offers that.
 */
export const GET = apiRoute<Context>(async (request, context) => {
  await requirePermission(request, 'application:read');
  const { id } = paramsSchema.parse(await context.params);
  const application = await getApplication(id);
  if (!application) throw new NotFoundError(msg(messages, 'error.applicationNotFound'));

  const [routes, live, targets, proxies] = await Promise.all([
    listRoutes({ applicationId: id }),
    listLiveDeployments({ applicationId: id }),
    listTargets(),
    listServingProxies(),
  ]);
  const nameOf = new Map(targets.map((target) => [target.id, target.name]));
  const targetIds = new Set([
    ...live.filter((couple) => couple.inService).map((couple) => couple.targetId),
    ...routes.map((route) => route.targetId),
  ]);
  return NextResponse.json({
    defaultHost: application.appSpec.ingress?.host ?? null,
    targets: targets
      .filter((target) => targetIds.has(target.id))
      .map((target) => {
        const serving = proxies.get(target.id);
        return {
          id: target.id,
          name: target.name,
          live: live.some((couple) => couple.targetId === target.id && couple.inService),
          proxy: serving ? proxyViewForUi(serving.proxy) : null,
          /** The proxy, when it is another machine's or a remote proxy. */
          via: serving?.link
            ? (nameOf.get(serving.proxy.hostTargetId ?? '') ?? serving.proxy.name)
            : null,
          routes: routes.filter((route) => route.targetId === target.id).map(routeViewForUi),
        };
      }),
  });
});

const putSchema = z.object({
  targetId: z.string().uuid(),
  routes: routeListSchema,
});

/**
 * Replaces the application's domains on a target, and sets them right away on
 * the proxy if it runs there — without redeployment. Otherwise, the next
 * deployment will set them.
 */
export const PUT = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'deployment:create');
  const { id } = paramsSchema.parse(await context.params);
  const application = await getApplication(id);
  if (!application) throw new NotFoundError(msg(messages, 'error.applicationNotFound'));
  const input = await readJsonBody(request, putSchema);
  const target = await getTarget(input.targetId);
  if (!target) throw new NotFoundError(msg(messages, 'error.targetNotFound'));
  const proxy = (await resolveServingProxy(input.targetId))?.proxy ?? null;
  if (!proxy && input.routes.length > 0) {
    throw new ConflictError(msg(messages, 'error.noProxy', { target: target.name }));
  }
  if (proxy?.status === 'installing' && input.routes.length > 0) {
    throw new ConflictError(msg(messages, 'error.installing'));
  }
  if (proxy && proxy.status !== 'installing') {
    assertServable(input.routes, proxyCapabilities(proxy.kind, proxy.config));
  }

  const before = await listRoutes({ applicationId: id, targetId: input.targetId });
  const normalized = input.routes.map((route) => ({
    hostname: route.hostname,
    tls: route.tls,
    redirectHttps: route.tls && route.redirectHttps,
    waf: route.waf,
  }));
  try {
    await replaceRoutes(id, input.targetId, normalized);
  } catch (error) {
    if (error instanceof RouteTakenError) {
      throw new ConflictError(
        msg(messages, error.application ? 'error.routeTaken' : 'error.routeTakenElsewhere', {
          hostname: error.hostname,
          application: error.application ?? '',
        }),
      );
    }
    throw error;
  }

  const [live] = await listLiveDeployments({ applicationId: id, targetId: input.targetId });
  let jobId: string | null = null;
  if (live?.inService && proxy) {
    const job = await getOpsQueue().add(PROXY_APPLY_JOB, {
      applicationId: id,
      targetId: input.targetId,
      actorId: auth.userId,
      ip: auth.ip,
    });
    if (!job.id) throw new HttpError(500, 'enqueue_failed', msg(messages, 'error.jobNoId'));
    jobId = job.id;
  }
  await logAudit({
    actorId: auth.userId,
    action: 'application.routes.updated',
    resourceType: 'application',
    resourceId: id,
    before: {
      target: target.name,
      domains: before.map((route) => route.hostname),
      protection: Object.fromEntries(before.map((route) => [route.hostname, route.waf])),
    },
    after: {
      target: target.name,
      domains: normalized.map((route) => route.hostname),
      protection: Object.fromEntries(normalized.map((route) => [route.hostname, route.waf])),
    },
    ip: auth.ip,
  });
  const routes = await listRoutes({ applicationId: id, targetId: input.targetId });
  return NextResponse.json({ routes: routes.map(routeViewForUi), jobId });
});
