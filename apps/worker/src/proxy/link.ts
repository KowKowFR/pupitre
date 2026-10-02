import { intersectPortRanges, type PortRange } from '@pupitre/core';
import type { LogSink, TargetContext } from '@pupitre/core/drivers';
import { checkReach, reachSource, type ReachResult } from '@pupitre/core/proxy';
import { disconnect } from '@pupitre/core/ssh';
import {
  getProxy,
  getTargetLink,
  getTargetPortReport,
  listRoutes,
  resolveServingProxy,
  setTargetLinkCheck,
} from '@pupitre/db';
import { openTargetContext } from '../deploy/target-context.js';
import { env } from '../env.js';
import { openProxy } from './connect.js';

/**
 * Le proxy central, éprouvé : la machine du proxy ouvre-t-elle vraiment une
 * connexion vers celle qu'il sert ? Le test de la liaison (« Tester la
 * liaison », et à sa création) et le préflight d'un déploiement passent par
 * ici, et en retiennent le résultat sur la liaison — l'écran le montre,
 * `exposureFor()` en tire l'adresse à qui ouvrir le port.
 */

export type LinkCheck = {
  result: ReachResult;
  /** Le nom du proxy, pour le dire : sa machine, ou la connexion distante. */
  proxyHostName: string;
};

export async function verifyTargetLink(input: {
  targetId: string;
  /** Une session déjà ouverte vers la machine servie — celle du déploiement. */
  served?: TargetContext;
  /** La plage où l'application sera publiée ; à défaut, celle de la cible. */
  portRange?: PortRange;
  onLog?: LogSink;
}): Promise<LinkCheck | null> {
  const link = await getTargetLink(input.targetId);
  if (!link) return null;
  const proxy = await getProxy(link.proxyId);
  if (!proxy) throw new Error('le proxy de cette liaison a disparu');

  // Un port libre de la plage, hors des réservations du panel : là où le
  // driver publiera, donc là où un pare-feu bloquerait l'application.
  const report = await getTargetPortReport(input.targetId);
  if (!report) throw new Error('cible introuvable');
  const portRange =
    input.portRange ?? intersectPortRanges(report.range, env.DRIVER_PORT_RANGE) ?? report.range;
  const reserved = new Set(report.allocations.map((allocation) => allocation.port));

  const opened = await openProxy(proxy);
  const served = input.served ? null : await openTargetContext(input.targetId);
  try {
    const result = await checkReach({
      origin: opened.reachOrigin(input.onLog),
      served: input.served ?? served!.ctx,
      address: link.address,
      portRange,
      reserved,
      ...(input.onLog ? { onLog: input.onLog } : {}),
    });
    // Pas pu éprouver la connexion, ou pas su d'où le proxy arrive : la
    // liaison reste utilisable, l'avertissement est retenu à sa place.
    await setTargetLinkCheck(input.targetId, {
      status: result.ok === false ? 'failed' : 'ok',
      sourceAddress: reachSource(result),
      bindable: result.bindable,
      error: result.ok === true && reachSource(result) !== null ? null : result.detail,
    });
    return { result, proxyHostName: opened.name };
  } finally {
    await opened.close();
    if (served) await disconnect(served.session);
  }
}

/**
 * Au préflight d'un déploiement servi par le proxy d'une autre machine — et
 * seulement s'il a des domaines —, éprouver la connexion **avant** de rien
 * construire. Une machine que le proxy ne joint pas fait échouer le
 * déploiement tout de suite, en disant quoi ouvrir, plutôt qu'au bout d'un
 * build par un domaine muet.
 *
 * `true` : éprouvée (la liaison est à jour, l'exposition est à relire) ;
 * `false` : sans objet.
 */
export async function verifyLinkBeforeDeploy(input: {
  applicationId: string;
  targetId: string;
  served: TargetContext;
  portRange: PortRange;
  onLog: LogSink;
}): Promise<boolean> {
  const serving = await resolveServingProxy(input.targetId);
  if (!serving?.link) return false;
  const routes = await listRoutes({ applicationId: input.applicationId, targetId: input.targetId });
  if (routes.length === 0) return false;

  const checked = await verifyTargetLink({
    targetId: input.targetId,
    served: input.served,
    portRange: input.portRange,
    onLog: input.onLog,
  });
  if (!checked) return false;
  const { result, proxyHostName } = checked;
  if (result.ok === false) {
    throw new Error(
      `le proxy de « ${proxyHostName} » ne joint pas cette machine : ${result.detail}. ` +
        `Rétablissez le passage de « ${proxyHostName} » vers ${result.address} ` +
        `(ports ${input.portRange.min}-${input.portRange.max}), puis « Tester la liaison » ` +
        'dans l’onglet Reverse proxy de la cible.',
    );
  }
  const source = reachSource(result);
  input.onLog(
    result.ok
      ? `✓ liaison au proxy de « ${proxyHostName} » : ${result.detail}${source ? ` — arrivée depuis ${source}` : ''}`
      : `⚠ ${result.detail}`,
  );
  return true;
}
