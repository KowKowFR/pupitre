import type { MonitorType } from '../monitors/catalog.js';
import { domainProbe } from './domain.js';
import { httpProbe } from './http.js';
import { keywordProbe } from './keyword.js';
import { tlsProbe } from './tls.js';
import type { MonitorProbe } from './types.js';

/**
 * La fabrique de sondes — même forme que `getDriver(runtime)`.
 *
 * **Ajouter un type de surveillance** (DNS, empreinte de contenu) : écrire
 * `packages/core/src/probe/<type>.ts`, ajouter son entrée au catalogue
 * (`monitors/catalog.ts`), et une ligne au registre ci-dessous. La table
 * `monitors`, le balayage, les routes REST et l'écran ne bougent pas.
 */
const PROBES: Record<MonitorType, MonitorProbe> = {
  http: httpProbe,
  keyword: keywordProbe,
  tls: tlsProbe,
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
export {
  domainProbe,
  judgeDomain,
  readBootstrap,
  readRdapDomain,
  rdapEndpointFor,
  resetRdapBootstrapCache,
} from './domain.js';
