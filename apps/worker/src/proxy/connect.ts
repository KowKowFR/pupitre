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
import { instanceLanguage } from '../language.js';
import { workerSay } from '../messages.js';

/**
 * A proxy ready to serve, wherever it runs. The worker only does this with a
 * proxy — set routes, probe them, test it, test a link — and does not have to
 * know whether it goes through SSH (a proxy on a machine) or through an API (a
 * remote proxy): it is decided here, on the kind's placement, once and for all.
 */
export type OpenProxy = {
  /** For the messages: the proxy's machine, or the remote connection's name. */
  name: string;
  apply(set: ProxyRouteSet, onLog: LogSink): Promise<void>;
  probe(route: ProxyRoute, path: string): Promise<RouteProbe>;
  check(onLog: LogSink): Promise<ProxyCheck>;
  /** Where to test the path to a served machine from (`checkReach()`). */
  reachOrigin(onLog?: LogSink): ReachOrigin;
  close(): Promise<void>;
};

export function proxyContextOf(proxy: ProxyView, host: TargetContext): ProxyContext {
  return { ...host, config: proxy.config };
}

/**
 * Opens the proxy. `local`: a session already open — reused if it is the proxy
 * machine's, otherwise we open its own for the duration of the gesture.
 */
export async function openProxy(proxy: ProxyView, local?: TargetContext): Promise<OpenProxy> {
  if (proxyPlacement(proxy.kind) === 'remote') {
    const provider = getRemoteProxyProvider(proxy.kind);
    // The API credentials, decrypted here and nowhere else.
    const ctx = {
      config: proxy.config,
      secrets: await resolveProxySecrets(proxy.id),
      language: await instanceLanguage(),
    };
    return {
      name: proxy.name,
      apply: (set, onLog) => provider.apply(ctx, set, onLog),
      probe: (route, path) => provider.probe(ctx, route, path),
      check: (onLog) => provider.check(ctx, onLog),
      reachOrigin: (onLog = () => {}) => ({
        name: proxy.name,
        // A remote proxy does not tell its routing table: only the connection counts.
        routeSource: async () => undefined,
        connect: (address, port, token) => provider.reach(ctx, { address, port, token }, onLog),
      }),
      close: async () => {},
    };
  }

  if (!proxy.hostTargetId) throw new Error(workerSay(await instanceLanguage())('proxy.noHost'));
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

/** For the duration of a gesture: the proxy opened, then closed whatever happens. */
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
