import { exposedService, type AppSpec } from '@pupitre/core';
import type {
  DeploymentDriver,
  DriverContext,
  DriverExposure,
  LogSink,
  TargetContext,
} from '@pupitre/core/drivers';
import { CERTIFICATE_RECHECK_DELAYS_MS, ROUTES_CHECK_JOB } from '@pupitre/core';
import {
  getProxyProvider,
  type ProxyContext,
  type ProxyRoute,
  type ProxyUpstream,
  type RouteProbe,
} from '@pupitre/core/proxy';
import { disconnect } from '@pupitre/core/ssh';
import {
  deleteRoutesOf,
  listRoutes,
  logAudit,
  replaceRoutes,
  RouteTakenError,
  resolveServingProxy,
  setRouteStatus,
  type ProxyView,
  type RouteView,
  type ServingProxy,
} from '@pupitre/db';
import { openTargetContext } from '../deploy/target-context.js';
import { getSupervisionQueue } from '../queue.js';

/**
 * Les domaines d'une application sur une cible, côté worker : les poser sur le
 * proxy, les éprouver à travers lui, et retenir ce qu'ils donnent.
 *
 * Partagé par l'étape `proxy` du pipeline, par « Appliquer » (des domaines
 * changés sans redéploiement), par la destruction et par la sonde périodique.
 * Aucun runtime n'est nommé ici : l'amont vient du driver, la route du proxy.
 */

export function proxyContextOf(proxy: ProxyView, host: TargetContext): ProxyContext {
  return { ...host, config: proxy.config };
}

/**
 * Une session vers la machine **du proxy**. Pour le proxy de la machine même,
 * c'est celle qu'on a déjà ; pour celui d'une autre — le proxy central —, on
 * l'ouvre le temps du geste.
 */
async function withProxyHost<T>(
  serving: ServingProxy,
  local: TargetContext,
  run: (ctx: ProxyContext) => Promise<T>,
): Promise<T> {
  if (!serving.link) return run(proxyContextOf(serving.proxy, local));
  if (!serving.proxy.hostTargetId) throw new Error('ce proxy ne tourne sur aucune machine connue');
  const opened = await openTargetContext(serving.proxy.hostTargetId);
  try {
    return await run(proxyContextOf(serving.proxy, opened.ctx));
  } finally {
    await disconnect(opened.session);
  }
}

/**
 * Ce qui distingue cette machine chez un proxy qui en sert plusieurs. Absent
 * pour la machine du proxy : ses objets gardent le nom de l'application, comme
 * avant que le proxy central n'existe.
 */
function scopeOf(serving: ServingProxy, targetId: string): string | undefined {
  return serving.link ? `t${targetId.slice(0, 8)}` : undefined;
}

/**
 * Par où le proxy joint l'application : ce que le driver annonce, plus, pour
 * un proxy distant, l'adresse de la machine — il ne joint qu'un port publié.
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
    throw new Error(
      "l'application ne publie aucun port que le proxy distant puisse joindre — redéployez-la pour qu'elle en publie un",
    );
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

/** Le chemin de santé du service routé — celui que l'on interroge à travers le proxy. */
export function routedHealthPath(spec: AppSpec): string {
  const name = spec.ingress?.targetService ?? exposedService(spec).name;
  const service =
    spec.services.find((candidate) => candidate.name === name) ?? exposedService(spec);
  return service.healthcheck.path;
}

export function routeUrl(route: Pick<RouteView, 'hostname' | 'tls'>): string {
  return `${route.tls ? 'https' : 'http'}://${route.hostname}`;
}

/**
 * Au premier déploiement d'une application sur une cible, le domaine de son
 * AppSpec devient une route — c'est sa valeur par défaut. Ensuite, c'est la
 * liste des domaines de la cible qui fait foi : un domaine retiré à la main ne
 * revient pas au déploiement suivant.
 */
export async function seedRouteFromSpec(
  applicationId: string,
  targetId: string,
  spec: AppSpec,
  onLog: LogSink,
): Promise<void> {
  const host = spec.ingress?.host;
  if (!host) return;
  const existing = await listRoutes({ applicationId, targetId });
  if (existing.length > 0) return;
  try {
    const tls = spec.ingress?.tls ?? false;
    await replaceRoutes(applicationId, targetId, [
      // La protection par défaut : celle d'un proxy qui est un WAF, ignorée sinon.
      { hostname: host.toLowerCase(), tls, redirectHttps: tls, waf: 'block' },
    ]);
    onLog(`domaine de l'AppSpec retenu : ${host}`);
  } catch (error) {
    if (error instanceof RouteTakenError) onLog(`⚠ ${error.message} — il n'est pas repris`);
    else throw error;
  }
}

/**
 * Comment publier l'application, au vu de ses domaines et de qui les sert :
 *   proxy de la machine  → sur la boucle locale, s'il la joint par là ;
 *   proxy d'une autre    → un port publié (un NodePort en K3s), sur l'adresse
 *                          privée que joint le proxy si elle est à cette
 *                          machine, et le pare-feu ouvert à lui seul.
 * `undefined` : pas de domaine, ou pas de proxy — la publication habituelle.
 */
export async function exposureFor(
  applicationId: string,
  targetId: string,
): Promise<DriverExposure | undefined> {
  const serving = await resolveServingProxy(targetId);
  // Un proxy en cours d'installation n'a pas encore sa configuration.
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
 * Retient ce qu'une sonde a donné, et le dit quand ça change pour de bon.
 *
 * `confirm` : une première sonde en échec sur une route qui marchait est mise
 * de côté — l'erreur est notée, la route reste active ; la seconde de suite la
 * fait tomber et prévient. Un redémarrage de proxy ou un déploiement en cours
 * ne réveille personne. Le pipeline, lui, tranche tout de suite : il vient de
 * tout poser et il a déjà réessayé.
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
  };
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

export type AppliedRoutes = {
  /** Pourquoi rien n'a été posé, quand rien ne l'a été. */
  skipped: string | null;
  /** L'URL à retenir pour l'application : son premier domaine qui répond. */
  url: string | null;
  /** Les domaines qui ne répondent pas, avec la raison. */
  problems: string[];
};

/**
 * Pose sur le proxy l'ensemble des domaines du couple, puis les éprouve.
 * Une liste vide retire ce que le proxy portait pour l'application.
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
  const serving = await resolveServingProxy(targetId);
  const routes = await listRoutes({ applicationId, targetId });
  if (!serving) {
    const reason =
      routes.length > 0
        ? `aucun reverse proxy ne sert cette cible : ${routes.map((route) => route.hostname).join(', ')} non routé(s)`
        : 'aucun reverse proxy ne sert cette cible — application jointe par son port';
    return { skipped: reason, url: null, problems: [] };
  }
  if (serving.proxy.status === 'installing') {
    return {
      skipped:
        'le reverse proxy est en cours d’installation — domaines posés au prochain déploiement',
      url: null,
      problems: [],
    };
  }
  if (serving.link && routes.length > 0) {
    onLog(`servie par le proxy d'une autre machine, qui la joint à ${serving.link.address}`);
  }

  const provider = getProxyProvider(serving.proxy.kind);
  return withProxyHost(serving, ctx, async (proxyCtx) => {
    await provider.apply(
      proxyCtx,
      {
        appSlug: ctx.appSlug,
        ...(scopeOf(serving, targetId) ? { scope: scopeOf(serving, targetId)! } : {}),
        routes: routes.map(toProxyRoute),
        upstream: upstreamOf(serving, driver, ctx, input.publishedPort),
      },
      onLog,
    );
    if (routes.length === 0) {
      return { skipped: 'aucun domaine pour cette application', url: null, problems: [] };
    }

    // Un proxy relit sa configuration en une ou deux secondes ; un contrôleur
    // d'ingress, parfois davantage. On réessaie un temps raisonnable avant de
    // conclure.
    const path = routedHealthPath(ctx.spec);
    const problems: string[] = [];
    let url: string | null = null;
    let certificatePending = false;
    for (const route of routes) {
      let probe = await provider.probe(proxyCtx, toProxyRoute(route), path);
      for (let attempt = 1; attempt < 10 && !probe.ok; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        probe = await provider.probe(proxyCtx, toProxyRoute(route), path);
      }
      await recordProbe(route, probe, { confirm: false });
      const certificate =
        probe.certificate.status === 'pending'
          ? ' — certificat en cours d’émission'
          : probe.certificate.status === 'valid'
            ? ` — certificat valide jusqu’au ${probe.certificate.notAfter?.slice(0, 10) ?? '?'}`
            : '';
      onLog(
        `${probe.ok ? '✓' : '✗'} ${route.hostname} — ${probe.detail}${probe.ok ? certificate : ''}`,
      );
      if (probe.ok) url ??= routeUrl(route);
      else problems.push(`${route.hostname} : ${probe.detail}`);
      if (probe.certificate.status === 'pending') certificatePending = true;
    }
    // Un certificat s'obtient en quelques secondes, la tournée passe toutes les
    // dix minutes : on relit ce couple bientôt, pour que l'écran le voie émis.
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
 * La sonde périodique : éprouve sans rien poser, et prévient des changements.
 * `proxyHost` : une session vers la machine du proxy — c'est de là qu'on sonde.
 */
export async function probeCoupleRoutes(input: {
  applicationId: string;
  targetId: string;
  spec: AppSpec;
  serving: ServingProxy;
  proxyHost: TargetContext;
}): Promise<{ checked: number; failing: number }> {
  const routes = await listRoutes({ applicationId: input.applicationId, targetId: input.targetId });
  if (routes.length === 0) return { checked: 0, failing: 0 };
  const provider = getProxyProvider(input.serving.proxy.kind);
  const proxyCtx = proxyContextOf(input.serving.proxy, input.proxyHost);
  const path = routedHealthPath(input.spec);
  let failing = 0;
  for (const route of routes) {
    const probe = await provider.probe(proxyCtx, toProxyRoute(route), path);
    await recordProbe(route, probe, { confirm: true });
    if (!probe.ok) failing += 1;
  }
  return { checked: routes.length, failing };
}

/**
 * À la destruction du déploiement en service : retirer ses routes du proxy, et
 * libérer ses domaines. Un proxy injoignable ne bloque pas la destruction — il
 * est dit, la base est nettoyée quand même.
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
      await withProxyHost(serving, input.ctx, (proxyCtx) =>
        getProxyProvider(serving.proxy.kind).apply(
          proxyCtx,
          {
            appSlug: input.ctx.appSlug,
            ...(scopeOf(serving, input.targetId)
              ? { scope: scopeOf(serving, input.targetId)! }
              : {}),
            routes: [],
            // L'amont ne sert ici qu'à retrouver où les routes ont été posées.
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
        `⚠ routes non retirées du proxy : ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const removed = await deleteRoutesOf(input.applicationId, input.targetId);
  if (removed > 0) input.onLog(`${removed} domaine(s) libéré(s)`);
}
