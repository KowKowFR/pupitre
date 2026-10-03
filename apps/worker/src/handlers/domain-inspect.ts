import {
  domainInspectJobDataSchema,
  domainInspectionSchema,
  type DomainInspection,
} from '@pupitre/core';
import { inspectDomain } from '@pupitre/core/probe';
import { getRouteById, getTarget, listServingProxies } from '@pupitre/db';
import type { Job } from 'bullmq';
import { logger } from '../logger.js';
import { allowedCidrs } from '../monitors/policy.js';

/**
 * Le relevé d'un domaine, demandé par son tiroir : où mène le nom, à qui il
 * appartient, quel certificat il présente.
 *
 * Le panel n'envoie que l'identifiant de la route : le nom, la présence de TLS
 * et la machine du proxy se relisent ici, en base — la question ne peut pas
 * porter sur autre chose qu'un domaine de l'instance.
 *
 * Aucune écriture : ni au journal (une lecture de ce qu'on a le droit de voir),
 * ni sur la route (son état est celui que le proxy constate, depuis la
 * machine ; ce relevé est vu du worker, et ne le remplace pas).
 */
export async function handleDomainInspect(job: Job): Promise<DomainInspection> {
  const { routeId } = domainInspectJobDataSchema.parse(job.data);
  const route = await getRouteById(routeId);
  if (!route) throw new Error('domaine introuvable');

  // La machine qui porte le proxy du nom — la sienne, ou celle d'un proxy
  // central. Un proxy distant (joint par son API) n'en a pas : on ne sait
  // alors pas où le nom devrait mener.
  const serving = (await listServingProxies()).get(route.targetId);
  const hostTarget = serving?.proxy.hostTargetId
    ? await getTarget(serving.proxy.hostTargetId)
    : null;

  const inspection = await inspectDomain({
    hostname: route.hostname,
    tls: route.tls,
    expectedHosts: hostTarget ? [hostTarget.host] : [],
    allowlist: allowedCidrs(),
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
    'relevé de domaine terminé',
  );
  return domainInspectionSchema.parse(inspection);
}
