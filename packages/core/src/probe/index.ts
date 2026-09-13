import type { MonitorType } from '../monitors/catalog.js';
import { dnsProbe } from './dns.js';
import { httpProbe } from './http.js';
import { tcpProbe } from './tcp.js';
import { tlsProbe } from './tls.js';
import type { MonitorProbe } from './types.js';

/**
 * La fabrique de sondes — même forme que `getDriver(runtime)`.
 *
 * **Ajouter un type de surveillance** (DNS, expiration de domaine, empreinte de
 * contenu) : écrire `packages/core/src/probe/<type>.ts`, ajouter son entrée au
 * catalogue (`monitors/catalog.ts`), et une ligne au registre ci-dessous. La
 * table `monitors`, le balayage, les routes REST et l'écran ne bougent pas.
 */
const PROBES: Record<MonitorType, MonitorProbe> = {
  http: httpProbe,
  tls: tlsProbe,
  tcp: tcpProbe,
  dns: dnsProbe,
};

export function getMonitorProbe(type: MonitorType): MonitorProbe {
  return PROBES[type];
}

export * from './types.js';
export * from './net.js';
export * from './webhook.js';
export { httpProbe } from './http.js';
export { tlsProbe } from './tls.js';
export { tcpProbe } from './tcp.js';
export { dnsProbe } from './dns.js';
