import 'server-only';
import { CERTIFICATE_WARN_DAYS } from '@pupitre/core/proxy';
import { listRoutes, listServingProxies, listTargets } from '@pupitre/db';
import { proxyViewForUi, routeViewForUi, type RouteViewForUi } from './proxy';

const DAY_MS = 86_400_000;

/** Un domaine de l'instance, tel que la page « Domaines » et son API le rendent. */
export type DomainRow = RouteViewForUi & {
  /** Le proxy qui le sert, ou `null` : la machine n'en a plus. */
  proxy: { name: string; description: string; waf: boolean } | null;
  /** La machine du proxy, quand c'est celui d'une autre, ou un proxy distant. */
  via: string | null;
  /**
   * Jours pleins avant l'échéance du certificat, ou depuis, s'il est échu (alors
   * négatif) ; `null` sans certificat lu. Échu depuis quelques heures : `0`.
   */
  certificateDaysLeft: number | null;
  certificateExpired: boolean;
  /** Le domaine mérite qu'on le regarde : il ne répond pas, ou son certificat arrive à échéance. */
  attention: boolean;
};

/**
 * Tous les domaines de l'instance, avec le proxy qui les sert et l'état de
 * leur certificat. Trois lectures, quel que soit leur nombre : les routes, les
 * machines, et le proxy de chacune.
 */
export async function listDomains(now: number = Date.now()): Promise<DomainRow[]> {
  const [routes, targets, proxies] = await Promise.all([
    listRoutes({}),
    listTargets(),
    listServingProxies(),
  ]);
  const nameOf = new Map(targets.map((target) => [target.id, target.name]));

  return routes
    .map((route) => {
      const serving = proxies.get(route.targetId);
      const view = serving ? proxyViewForUi(serving.proxy) : null;
      const expiresAt = route.certificate?.notAfter ? Date.parse(route.certificate.notAfter) : NaN;
      const left = route.tls && !Number.isNaN(expiresAt) ? expiresAt - now : null;
      // Vers zéro dans les deux sens : échu depuis deux jours et des poussières
      // se dit « deux jours », pas trois.
      const daysLeft = left === null ? null : Math.trunc(left / DAY_MS);
      return {
        ...routeViewForUi(route),
        proxy: view
          ? { name: view.name, description: view.description, waf: view.capabilities.waf }
          : null,
        via: serving?.link
          ? (nameOf.get(serving.proxy.hostTargetId ?? '') ?? serving.proxy.name)
          : null,
        certificateDaysLeft: daysLeft,
        certificateExpired: left !== null && left < 0,
        attention:
          route.status === 'failed' ||
          route.certificateAlert !== null ||
          (daysLeft !== null && daysLeft < CERTIFICATE_WARN_DAYS),
      };
    })
    .sort((a, b) => a.hostname.localeCompare(b.hostname));
}
