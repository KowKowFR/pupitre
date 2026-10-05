import { exposedService, type AppSpec, type UiLanguage } from '@pupitre/core';
import type {
  DeploymentDriver,
  DriverContext,
  DriverExposure,
  LogSink,
} from '@pupitre/core/drivers';
import { CERTIFICATE_RECHECK_DELAYS_MS, ROUTES_CHECK_JOB } from '@pupitre/core';
import {
  certificateTransition,
  getProxyProvider,
  type ProxyRoute,
  type ProxyUpstream,
  type RouteProbe,
} from '@pupitre/core/proxy';
import {
  deleteRoutesOf,
  listRoutes,
  logAudit,
  replaceRoutes,
  RouteTakenError,
  resolveServingProxy,
  setRouteCertificateAlert,
  setRouteStatus,
  type RouteView,
  type ServingProxy,
} from '@pupitre/db';
import { workerSay } from '../messages.js';
import { getSupervisionQueue } from '../queue.js';
import { withProxy, type OpenProxy } from './connect.js';

/**
 * An application's domains on a target, worker side: set them on the proxy,
 * test them through it, and keep what they give.
 *
 * Shared by the pipeline's `proxy` step, by "Apply" (domains changed without a
 * redeploy), by destruction and by the periodic probe. No runtime is named here:
 * the upstream comes from the driver, the route from the proxy.
 */

/**
 * What tells this machine apart at a proxy that serves several. Absent for the
 * proxy's machine: its objects keep the application's name, as before the
 * central proxy existed.
 */
function scopeOf(serving: ServingProxy, targetId: string): string | undefined {
  return serving.link ? `t${targetId.slice(0, 8)}` : undefined;
}

/**
 * How the proxy reaches the application: what the driver announces, plus, for
 * another machine's proxy or a remote proxy, this machine's address — it only
 * reaches a published port.
 */
function upstreamOf(
  serving: ServingProxy,
  driver: DeploymentDriver,
  ctx: DriverContext,
  publishedPort: number | null,
): ProxyUpstream | null {
  const upstream = driver.upstream(ctx, publishedPort);
  if (!serving.link || !upstream) return upstream;
  if (upstream.kind !== 'port') {
    throw new Error(workerSay(ctx.language)('proxy.remoteNeedsPort'));
  }
  return { ...upstream, host: serving.link.address };
}

function toProxyRoute(route: RouteView): ProxyRoute {
  return {
    hostname: route.hostname,
    tls: route.tls,
    redirectHttps: route.redirectHttps,
    waf: route.waf,
  };
}

/** The routed service's health path — the one queried through the proxy. */
function routedHealthPath(spec: AppSpec): string {
  const name = spec.ingress?.targetService ?? exposedService(spec).name;
  const service =
    spec.services.find((candidate) => candidate.name === name) ?? exposedService(spec);
  return service.healthcheck.path;
}

function routeUrl(route: Pick<RouteView, 'hostname' | 'tls'>): string {
  return `${route.tls ? 'https' : 'http'}://${route.hostname}`;
}

/**
 * At an application's first deployment on a target, its AppSpec's domain becomes
 * a route — it is its default value. Afterwards, it is the target's list of
 * domains that is authoritative: a domain removed by hand does not come back at
 * the next deployment.
 */
export async function seedRouteFromSpec(
  applicationId: string,
  targetId: string,
  spec: AppSpec,
  language: UiLanguage,
  onLog: LogSink,
): Promise<void> {
  const host = spec.ingress?.host;
  if (!host) return;
  const existing = await listRoutes({ applicationId, targetId });
  if (existing.length > 0) return;
  const say = workerSay(language);
  try {
    const tls = spec.ingress?.tls ?? false;
    await replaceRoutes(applicationId, targetId, [
      // The default protection: that of a proxy that is a WAF, ignored otherwise.
      { hostname: host.toLowerCase(), tls, redirectHttps: tls, waf: 'block' },
    ]);
    onLog(say('proxy.seeded', { hostname: host }));
  } catch (error) {
    if (!(error instanceof RouteTakenError)) throw error;
    onLog(
      error.application
        ? say('proxy.seedTakenBy', { hostname: error.hostname, application: error.application })
        : say('proxy.seedTaken', { hostname: error.hostname }),
    );
  }
}

/**
 * How to publish the application, given its domains and who serves them:
 *   the machine's proxy  → on loopback, if it reaches it that way;
 *   another's proxy      → a published port (a NodePort on K3s), on the private
 *                          address the proxy reaches if it belongs to this
 *                          machine, and the firewall opened to it alone.
 * `undefined`: no domain, or no proxy — the usual publication.
 */
export async function exposureFor(
  applicationId: string,
  targetId: string,
): Promise<DriverExposure | undefined> {
  const serving = await resolveServingProxy(targetId);
  // A proxy being installed does not have its configuration yet.
  if (!serving || serving.proxy.status === 'installing') return undefined;
  const routes = await listRoutes({ applicationId, targetId });
  if (routes.length === 0) return undefined;
  if (!serving.link) {
    const address = getProxyProvider(serving.proxy.kind).publishAddress(serving.proxy.config);
    return address ? { bindAddress: address } : undefined;
  }
  return {
    byPort: true,
    ...(serving.link.bindable ? { bindAddress: serving.link.address } : {}),
    ...(serving.link.sourceAddress ? { allowFrom: serving.link.sourceAddress } : {}),
  };
}

/**
 * Keeps what a probe gave, and says so when it changes for good.
 *
 * `confirm`: a first failed probe on a route that worked is set aside — the
 * error is noted, the route stays active; the second in a row brings it down and
 * warns. A proxy restart or a deployment in progress wakes nobody up. The
 * pipeline decides right away: it just set everything up and has already
 * retried.
 */
async function recordProbe(
  route: RouteView,
  probe: RouteProbe,
  options: { confirm: boolean },
): Promise<void> {
  const context = {
    hostname: route.hostname,
    application: route.applicationSlug,
    targetName: route.targetName,
    // What allows holding the alert when the machine is under maintenance: the entry
    // is in the application's name, the route and its target are here.
    routeId: route.id,
    targetId: route.targetId,
  };
  await watchCertificate(route, probe, context);
  if (probe.ok) {
    await setRouteStatus(route.id, {
      status: 'active',
      error: null,
      certificate: probe.certificate,
    });
    if (route.status === 'failed') {
      await logAudit({
        actorId: null,
        action: 'route.recovered',
        resourceType: 'application',
        resourceId: route.applicationId,
        after: context,
      });
    }
    return;
  }
  const suspected = options.confirm && route.status === 'active' && route.lastError === null;
  await setRouteStatus(route.id, {
    status: suspected ? 'active' : 'failed',
    error: probe.detail,
    certificate: probe.certificate,
  });
  if (route.status === 'active' && !suspected) {
    await logAudit({
      actorId: null,
      action: 'route.down',
      resourceType: 'application',
      resourceId: route.applicationId,
      after: { ...context, error: probe.detail },
    });
  }
}

/**
 * The certificate's expiry, seen at each probe: one alert when it enters its
 * last fourteen days — its renewal did not succeed —, only one per certificate,
 * and the announcement of its renewal.
 */
async function watchCertificate(
  route: RouteView,
  probe: RouteProbe,
  context: { hostname: string; application: string; targetName: string },
): Promise<void> {
  const transition = certificateTransition(route.certificateAlert, probe.certificate);
  if (!transition) return;
  await setRouteCertificateAlert(
    route.id,
    transition.kind === 'expiring' ? transition.notAfter : null,
  );
  await logAudit({
    actorId: null,
    action:
      transition.kind === 'expiring' ? 'route.certificate.expiring' : 'route.certificate.renewed',
    resourceType: 'application',
    resourceId: route.applicationId,
    after: {
      ...context,
      notAfter: transition.notAfter,
      issuer: probe.certificate?.issuer ?? null,
      ...(transition.kind === 'expiring' ? { daysLeft: transition.daysLeft } : {}),
    },
  });
}

export type AppliedRoutes = {
  /** Why nothing was set, when nothing was. */
  skipped: string | null;
  /** The URL to keep for the application: its first domain that answers. */
  url: string | null;
  /** The domains that do not answer, with the reason. */
  problems: string[];
};

/**
 * Sets the pair's whole set of domains on the proxy, then tests them. An empty
 * list removes what the proxy carried for the application.
 */
export async function applyCoupleRoutes(input: {
  applicationId: string;
  targetId: string;
  driver: DeploymentDriver;
  ctx: DriverContext;
  publishedPort: number | null;
  onLog: LogSink;
}): Promise<AppliedRoutes> {
  const { applicationId, targetId, driver, ctx, onLog } = input;
  const say = workerSay(ctx.language);
  const serving = await resolveServingProxy(targetId);
  const routes = await listRoutes({ applicationId, targetId });
  if (!serving) {
    const reason =
      routes.length > 0
        ? say('proxy.noneWithRoutes', {
            count: routes.length,
            hostnames: routes.map((route) => route.hostname).join(', '),
          })
        : say('proxy.none');
    return { skipped: reason, url: null, problems: [] };
  }
  if (serving.proxy.status === 'installing') {
    return { skipped: say('proxy.installing'), url: null, problems: [] };
  }
  if (serving.link && routes.length > 0) {
    onLog(say('proxy.servedBy', { proxy: serving.proxy.name, address: serving.link.address }));
  }

  return withProxy(serving.proxy, ctx, async (proxy) => {
    await proxy.apply(
      {
        appSlug: ctx.appSlug,
        ...(scopeOf(serving, targetId) ? { scope: scopeOf(serving, targetId)! } : {}),
        routes: routes.map(toProxyRoute),
        upstream: upstreamOf(serving, driver, ctx, input.publishedPort),
      },
      onLog,
    );
    if (routes.length === 0) {
      return { skipped: say('proxy.noDomain'), url: null, problems: [] };
    }

    // A proxy reads its configuration again in one or two seconds; an ingress
    // controller, sometimes more. We retry for a reasonable time before concluding.
    const path = routedHealthPath(ctx.spec);
    const problems: string[] = [];
    let url: string | null = null;
    let certificatePending = false;
    for (const route of routes) {
      let probe = await proxy.probe(toProxyRoute(route), path);
      for (let attempt = 1; attempt < 10 && !probe.ok; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        probe = await proxy.probe(toProxyRoute(route), path);
      }
      await recordProbe(route, probe, { confirm: false });
      const certificate =
        probe.certificate.status === 'pending'
          ? say('proxy.certificatePending')
          : probe.certificate.status === 'valid'
            ? say('proxy.certificateValid', {
                date: probe.certificate.notAfter?.slice(0, 10) ?? '?',
              })
            : '';
      onLog(
        `${probe.ok ? '✓' : '✗'} ${route.hostname} — ${probe.detail}${probe.ok ? certificate : ''}`,
      );
      if (probe.ok) url ??= routeUrl(route);
      else problems.push(say('proxy.problem', { hostname: route.hostname, detail: probe.detail }));
      if (probe.certificate.status === 'pending') certificatePending = true;
    }
    // A certificate is obtained in a few seconds, the round goes every ten minutes:
    // we read this pair again soon, so that the screen sees it issued.
    if (certificatePending) {
      for (const delay of CERTIFICATE_RECHECK_DELAYS_MS) {
        await getSupervisionQueue().add(
          ROUTES_CHECK_JOB,
          { applicationId, targetId },
          {
            delay,
            attempts: 1,
            removeOnComplete: { age: 3600, count: 100 },
            removeOnFail: { age: 86_400, count: 100 },
          },
        );
      }
    }
    return { skipped: null, url: url ?? routeUrl(routes[0]!), problems };
  });
}

/**
 * The periodic probe: tests without setting anything, and warns of changes.
 * `proxy`: the open proxy — it is through it that we probe.
 */
export async function probeCoupleRoutes(input: {
  applicationId: string;
  targetId: string;
  spec: AppSpec;
  proxy: OpenProxy;
}): Promise<{ checked: number; failing: number }> {
  const routes = await listRoutes({ applicationId: input.applicationId, targetId: input.targetId });
  if (routes.length === 0) return { checked: 0, failing: 0 };
  const path = routedHealthPath(input.spec);
  let failing = 0;
  for (const route of routes) {
    const probe = await input.proxy.probe(toProxyRoute(route), path);
    await recordProbe(route, probe, { confirm: true });
    if (!probe.ok) failing += 1;
  }
  return { checked: routes.length, failing };
}

/**
 * At the destruction of the deployment in service: remove its routes from the
 * proxy, and release its domains. An unreachable proxy does not block the
 * destruction — it is said, the database is cleaned up anyway.
 */
export async function removeCoupleRoutes(input: {
  applicationId: string;
  targetId: string;
  driver: DeploymentDriver;
  ctx: DriverContext;
  publishedPort: number | null;
  onLog: LogSink;
}): Promise<void> {
  const serving = await resolveServingProxy(input.targetId);
  if (serving) {
    try {
      await withProxy(serving.proxy, input.ctx, (proxy) =>
        proxy.apply(
          {
            appSlug: input.ctx.appSlug,
            ...(scopeOf(serving, input.targetId)
              ? { scope: scopeOf(serving, input.targetId)! }
              : {}),
            routes: [],
            // The upstream is only used here to find where the routes were set.
            upstream: (() => {
              try {
                return upstreamOf(serving, input.driver, input.ctx, input.publishedPort);
              } catch {
                return null;
              }
            })(),
          },
          input.onLog,
        ),
      );
    } catch (error) {
      input.onLog(
        workerSay(input.ctx.language)('proxy.notRemoved', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
  const removed = await deleteRoutesOf(input.applicationId, input.targetId);
  if (removed > 0) input.onLog(workerSay(input.ctx.language)('proxy.released', { count: removed }));
}
