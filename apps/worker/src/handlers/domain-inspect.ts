import {
  domainInspectJobDataSchema,
  domainInspectionSchema,
  type DomainInspection,
} from '@pupitre/core';
import { inspectDomain } from '@pupitre/core/probe';
import { getRouteById, getTarget, listServingProxies } from '@pupitre/db';
import type { Job } from 'bullmq';
import { instanceLanguage } from '../language.js';
import { logger } from '../logger.js';
import { allowedCidrs } from '../monitors/policy.js';

/**
 * A domain's reading, asked by its drawer: where the name leads, who it belongs
 * to, which certificate it presents.
 *
 * The panel only sends the route's identifier: the name, the presence of TLS and
 * the proxy's machine are read again here, in the database — the question cannot
 * be about anything other than one of the instance's domains.
 *
 * No write: neither to the log (a read of what one is allowed to see), nor on the
 * route (its state is the one the proxy observes, from the machine; this reading
 * is seen from the worker, and does not replace it).
 */
export async function handleDomainInspect(job: Job): Promise<DomainInspection> {
  const { routeId } = domainInspectJobDataSchema.parse(job.data);
  const route = await getRouteById(routeId);
  if (!route) throw new Error('domain not found');

  // The machine carrying the name's proxy — its own, or a central proxy's. A remote
  // proxy (reached through its API) has none: we then do not know where the name
  // should lead.
  const serving = (await listServingProxies()).get(route.targetId);
  const hostTarget = serving?.proxy.hostTargetId
    ? await getTarget(serving.proxy.hostTargetId)
    : null;

  const inspection = await inspectDomain({
    hostname: route.hostname,
    tls: route.tls,
    expectedHosts: hostTarget ? [hostTarget.host] : [],
    allowlist: allowedCidrs(),
    language: await instanceLanguage(),
  });

  logger.info(
    {
      jobId: job.id,
      routeId,
      hostname: route.hostname,
      dns: inspection.dns.status,
      registration: inspection.registration.status,
      certificate: inspection.certificate.status,
      pointing: inspection.pointing.status,
    },
    'domain reading completed',
  );
  return domainInspectionSchema.parse(inspection);
}
