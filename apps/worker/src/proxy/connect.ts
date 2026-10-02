import { proxyPlacement } from '@pupitre/core';
import type { LogSink, TargetContext } from '@pupitre/core/drivers';
import {
  getProxyProvider,
  getRemoteProxyProvider,
  sshReachOrigin,
  type ProxyCheck,
  type ProxyContext,
  type ProxyRoute,
  type ProxyRouteSet,
  type ReachOrigin,
  type RouteProbe,
} from '@pupitre/core/proxy';
import { disconnect } from '@pupitre/core/ssh';
import { resolveProxySecrets, type ProxyView } from '@pupitre/db';
import { openTargetContext } from '../deploy/target-context.js';

/**
 * Un proxy prêt à servir, où qu'il tourne. Le worker ne fait que cela avec un
 * proxy — poser des routes, les sonder, le tester, éprouver une liaison — et
 * n'a pas à savoir s'il passe par SSH (un proxy sur une machine) ou par une
 * API (un proxy distant) : c'est décidé ici, sur le placement du genre, une
 * fois pour toutes.
 */
export type OpenProxy = {
  /** Pour les messages : la machine du proxy, ou le nom de la connexion distante. */
  name: string;
  apply(set: ProxyRouteSet, onLog: LogSink): Promise<void>;
  probe(route: ProxyRoute, path: string): Promise<RouteProbe>;
  check(onLog: LogSink): Promise<ProxyCheck>;
  /** D'où éprouver le chemin vers une machine servie (`checkReach()`). */
  reachOrigin(onLog?: LogSink): ReachOrigin;
  close(): Promise<void>;
};

export function proxyContextOf(proxy: ProxyView, host: TargetContext): ProxyContext {
  return { ...host, config: proxy.config };
}

/**
 * Ouvre le proxy. `local` : une session déjà ouverte — reprise si c'est celle
 * de la machine du proxy, sinon on ouvre la sienne le temps du geste.
 */
export async function openProxy(proxy: ProxyView, local?: TargetContext): Promise<OpenProxy> {
  if (proxyPlacement(proxy.kind) === 'remote') {
    const provider = getRemoteProxyProvider(proxy.kind);
    // Les identifiants de l'API, déchiffrés ici et nulle part ailleurs.
    const ctx = { config: proxy.config, secrets: await resolveProxySecrets(proxy.id) };
    return {
      name: proxy.name,
      apply: (set, onLog) => provider.apply(ctx, set, onLog),
      probe: (route, path) => provider.probe(ctx, route, path),
      check: (onLog) => provider.check(ctx, onLog),
      reachOrigin: (onLog = () => {}) => ({
        name: proxy.name,
        // Un proxy distant ne dit pas sa table de routage : seule la connexion compte.
        routeSource: async () => undefined,
        connect: (address, port, token) => provider.reach(ctx, { address, port, token }, onLog),
      }),
      close: async () => {},
    };
  }

  if (!proxy.hostTargetId) throw new Error('ce proxy ne tourne sur aucune machine connue');
  const reuse = local?.target.id === proxy.hostTargetId ? local : null;
  const opened = reuse ? null : await openTargetContext(proxy.hostTargetId);
  const host = reuse ?? opened!.ctx;
  const provider = getProxyProvider(proxy.kind);
  const ctx = proxyContextOf(proxy, host);
  return {
    name: host.target.name,
    apply: (set, onLog) => provider.apply(ctx, set, onLog),
    probe: (route, path) => provider.probe(ctx, route, path),
    check: (onLog) => provider.check(ctx, onLog),
    reachOrigin: () => sshReachOrigin(host),
    close: async () => {
      if (opened) await disconnect(opened.session);
    },
  };
}

/** Le temps d'un geste : le proxy ouvert, puis refermé quoi qu'il arrive. */
export async function withProxy<T>(
  proxy: ProxyView,
  local: TargetContext | undefined,
  run: (open: OpenProxy) => Promise<T>,
): Promise<T> {
  const open = await openProxy(proxy, local);
  try {
    return await run(open);
  } finally {
    await open.close();
  }
}
