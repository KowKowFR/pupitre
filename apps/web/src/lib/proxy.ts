import 'server-only';
import {
  OPS_QUEUE,
  describeProxy,
  proxyCapabilities,
  type ProxyCapabilities,
  type ProxyKind,
  type RouteCertificate,
  isPrivateAddress,
} from '@pupitre/core';
import type { ProxyLinkRow, ProxyView, RouteView } from '@pupitre/db';
import { QueueEvents } from 'bullmq';
import { proxy as messages } from '@/i18n/messages/proxy';
import { ConflictError, msg } from './errors';
import { getRedis } from './redis';

/**
 * Ce que les routes et les écrans des reverse proxies partagent : la forme sous
 * laquelle une connexion et un domaine sortent de l'API, et l'attente d'une
 * tâche courte sur `ops`.
 */

declare global {
  var __tpOpsQueueEvents: QueueEvents | undefined;
}

/** Les événements de la file `ops` — pour attendre l'issue d'une tâche courte. */
export function opsQueueEvents(): QueueEvents {
  globalThis.__tpOpsQueueEvents ??= new QueueEvents(OPS_QUEUE, {
    connection: getRedis(),
  });
  return globalThis.__tpOpsQueueEvents;
}

export type ProxyViewForUi = {
  id: string;
  kind: ProxyKind;
  name: string;
  managed: boolean;
  status: ProxyView['status'];
  description: string;
  capabilities: ProxyCapabilities;
  /** Ce qui se montre de la configuration : mode, résolveur, ACME (e-mail, serveur). */
  mode: string;
  certResolver: string | null;
  acme: { email: string; server: string } | null;
  lastCheckedAt: string | null;
  lastCheckError: string | null;
  checks: Array<{ key: string; label: string; ok: boolean; detail: string | null }>;
};

export function proxyViewForUi(proxy: ProxyView): ProxyViewForUi {
  const config = proxy.config as {
    mode?: string;
    certResolver?: string | null;
    acme?: { email?: string; server?: string } | null;
  };
  let description: string;
  let capabilities: ProxyCapabilities;
  try {
    description = describeProxy(proxy.kind, proxy.config);
    capabilities = proxyCapabilities(proxy.kind, proxy.config);
  } catch {
    // Une installation en cours n'a pas encore sa configuration définitive.
    description = proxy.kind;
    capabilities = { autoTls: false, https: false, redirectHttps: false };
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
    mode: config.mode ?? '?',
    certResolver: config.certResolver ?? null,
    acme: config.acme?.email
      ? { email: config.acme.email, server: config.acme.server ?? 'production' }
      : null,
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

/** Refuse ce que le proxy ne sait pas servir, en le nommant. */
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

export type LinkViewForUi = {
  proxy: ProxyViewForUi;
  hostTargetId: string | null;
  hostTargetName: string;
  address: string;
  sourceAddress: string | null;
  bindable: boolean;
  /** L'adresse est privée : le trafic en clair entre les deux machines y reste. */
  privateAddress: boolean;
  status: ProxyLinkRow['status'];
  lastCheckedAt: string | null;
  lastCheckError: string | null;
};

export function linkViewForUi(
  link: ProxyLinkRow,
  proxy: ProxyView,
  hostTargetName: string,
): LinkViewForUi {
  return {
    proxy: proxyViewForUi(proxy),
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
