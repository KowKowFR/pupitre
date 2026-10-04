import type { MonitorType } from '../monitors/catalog.js';
import { dnsProbe } from './dns.js';
import { httpProbe } from './http.js';
import { tcpProbe } from './tcp.js';
import { domainProbe } from './domain.js';
import { keywordProbe } from './keyword.js';
import { tlsProbe } from './tls.js';
import type { MonitorProbe } from './types.js';

/**
 * The probe factory — the same shape as `getDriver(runtime)`.
 *
 * **Adding a kind of monitoring** (DNS, content fingerprint): write
 * `packages/core/src/probe/<type>.ts`, add its entry to the catalog
 * (`monitors/catalog.ts`), and a line to the registry below. The `monitors`
 * table, the sweep, the REST routes and the screen do not move.
 */
const PROBES: Record<MonitorType, MonitorProbe> = {
  http: httpProbe,
  keyword: keywordProbe,
  tls: tlsProbe,
  tcp: tcpProbe,
  dns: dnsProbe,
  domain: domainProbe,
};

export function getMonitorProbe(type: MonitorType): MonitorProbe {
  return PROBES[type];
}

export * from './types.js';
export * from './net.js';
export * from './fetch.js';
export * from './webhook.js';
export { httpProbe } from './http.js';
export { keywordProbe, containsKeyword, foldForSearch, stripMarkup } from './keyword.js';
export { tlsProbe } from './tls.js';
export { tcpProbe } from './tcp.js';
export { dnsProbe } from './dns.js';
export {
  domainProbe,
  judgeDomain,
  readBootstrap,
  readRdapDomain,
  rdapEndpointFor,
  resetRdapBootstrapCache,
} from './domain.js';
export { inspectDomain, type DomainInspectInput } from './domain-inspect.js';
