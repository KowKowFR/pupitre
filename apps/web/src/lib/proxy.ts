import 'server-only';
import {
  OPS_QUEUE,
  describeProxy,
  proxyAcme,
  proxyCapabilities,
  proxyPlacement,
  type ProxyCapabilities,
  type ProxyKind,
  type RouteCertificate,
  type UiLanguage,
  isPrivateAddress,
} from '@pupitre/core';
import type { ProxyLinkRow, ProxyView, RouteView } from '@pupitre/db';
import { QueueEvents, type Job } from 'bullmq';
import { proxy as messages } from '@/i18n/messages/proxy';
import { ConflictError, msg } from './errors';
import { getRedis } from './redis';

/**
 * What the reverse proxies' routes and screens share: the shape in which a
 * connection and a domain leave the API, and waiting for a short job on `ops`.
 */

declare global {
  var __tpOpsQueueEvents: QueueEvents | undefined;
}

/** The `ops` queue's events — to wait for a short job's outcome. */
export function opsQueueEvents(): QueueEvents {
  globalThis.__tpOpsQueueEvents ??= new QueueEvents(OPS_QUEUE, {
    connection: getRedis(),
  });
  return globalThis.__tpOpsQueueEvents;
}

/** What a proxy's test returns (`ProxyCheck`), as the screen reads it. */
export type ProxyCheckResult = {
  ok: boolean;
  checks: Array<{ key: string; label: string; ok: boolean; detail: string | null }>;
};

/**
 * 45 seconds: a few requests to the proxy's API and its entry, plus waiting in the
 * queue. Beyond that, `null` — the test will finish, and the screen will read it
 * again.
 */
const CHECK_TIMEOUT_MS = 45_000;

/** A proxy test's outcome, awaited — or `null` if it is late. */
export async function waitForProxyCheck(job: Job): Promise<ProxyCheckResult | null> {
  try {
    return ((await job.waitUntilFinished(opsQueueEvents(), CHECK_TIMEOUT_MS)) ??
      null) as ProxyCheckResult | null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/timed out/i.test(message)) return null;
    // The test itself failed: it is a result, not an outage of the route.
    return { ok: false, checks: [{ key: 'error', label: 'Test', ok: false, detail: message }] };
  }
}

export type ProxyViewForUi = {
  id: string;
  kind: ProxyKind;
  name: string;
  managed: boolean;
  status: ProxyView['status'];
  description: string;
  capabilities: ProxyCapabilities;
  /** The certificate authority set by Pupitre (email, server), if there is one. */
  acme: { email: string; server: string } | null;
  lastCheckedAt: string | null;
  lastCheckError: string | null;
  checks: Array<{ key: string; label: string; ok: boolean; detail: string | null }>;
};

export function proxyViewForUi(proxy: ProxyView, language: UiLanguage): ProxyViewForUi {
  let description: string;
  let capabilities: ProxyCapabilities;
  let acme: ProxyViewForUi['acme'] = null;
  try {
    description = describeProxy(proxy.kind, proxy.config, language);
    capabilities = proxyCapabilities(proxy.kind, proxy.config);
    acme = proxyAcme(proxy.kind, proxy.config);
  } catch {
    // An installation in progress does not have its final configuration yet.
    description = proxy.kind;
    capabilities = {
      autoTls: false,
      https: false,
      redirectHttps: false,
      waf: false,
      remoteUpstream: 'none',
    };
  }
  const check = proxy.lastCheck as { checks?: ProxyViewForUi['checks'] } | null;
  return {
    id: proxy.id,
    kind: proxy.kind,
    name: proxy.name,
    managed: proxy.managed,
    status: proxy.status,
    description,
    capabilities,
    acme,
    lastCheckedAt: proxy.lastCheckedAt?.toISOString() ?? null,
    lastCheckError: proxy.lastCheckError,
    checks: check?.checks ?? [],
  };
}

export type RouteViewForUi = {
  id: string;
  hostname: string;
  tls: boolean;
  redirectHttps: boolean;
  /** The protection, for a proxy that is also a WAF. */
  waf: RouteView['waf'];
  status: RouteView['status'];
  lastError: string | null;
  lastCheckedAt: string | null;
  certificate: RouteCertificate | null;
  applicationId: string;
  applicationSlug: string;
  targetId: string;
  targetName: string;
  url: string;
};

export function routeViewForUi(route: RouteView): RouteViewForUi {
  return {
    id: route.id,
    hostname: route.hostname,
    tls: route.tls,
    redirectHttps: route.redirectHttps,
    waf: route.waf,
    status: route.status,
    lastError: route.lastError,
    lastCheckedAt: route.lastCheckedAt?.toISOString() ?? null,
    certificate: route.certificate ?? null,
    applicationId: route.applicationId,
    applicationSlug: route.applicationSlug,
    targetId: route.targetId,
    targetName: route.targetName,
    url: `${route.tls ? 'https' : 'http'}://${route.hostname}`,
  };
}

/** Refuses what the proxy cannot serve, naming it. */
export function assertServable(
  routes: Array<{ hostname: string; tls: boolean }>,
  capabilities: ProxyCapabilities,
): void {
  for (const route of routes) {
    if (route.tls && !capabilities.https) {
      throw new ConflictError(
        msg(messages, 'error.httpsUnsupported', { hostname: route.hostname }),
      );
    }
  }
}

/**
 * A connection to a remote proxy, for the screen: its configuration shows —
 * address, account —, its secrets never. `linkCount`: the machines it serves.
 */
export type RemoteProxyViewForUi = ProxyViewForUi & {
  config: Record<string, unknown>;
  linkCount: number;
};

export function remoteProxyViewForUi(
  proxy: ProxyView & { linkCount?: number },
  language: UiLanguage,
): RemoteProxyViewForUi {
  return {
    ...proxyViewForUi(proxy, language),
    config: proxy.config,
    linkCount: proxy.linkCount ?? 0,
  };
}

export type LinkViewForUi = {
  proxy: ProxyViewForUi;
  /** A remote proxy, outside the targets: its connection, to change it. */
  remote: RemoteProxyViewForUi | null;
  hostTargetId: string | null;
  /** The proxy's machine — or, for a remote proxy, its connection's name. */
  hostTargetName: string;
  address: string;
  sourceAddress: string | null;
  bindable: boolean;
  /** The address is private: the plain traffic between the two machines stays there. */
  privateAddress: boolean;
  status: ProxyLinkRow['status'];
  lastCheckedAt: string | null;
  lastCheckError: string | null;
};

export function linkViewForUi(
  link: ProxyLinkRow,
  proxy: ProxyView,
  hostTargetName: string,
  language: UiLanguage,
): LinkViewForUi {
  return {
    proxy: proxyViewForUi(proxy, language),
    remote: proxyPlacement(proxy.kind) === 'remote' ? remoteProxyViewForUi(proxy, language) : null,
    hostTargetId: proxy.hostTargetId,
    hostTargetName,
    address: link.address,
    sourceAddress: link.sourceAddress,
    bindable: link.bindable,
    privateAddress: isPrivateAddress(link.address),
    status: link.status,
    lastCheckedAt: link.lastCheckedAt?.toISOString() ?? null,
    lastCheckError: link.lastCheckError,
  };
}
