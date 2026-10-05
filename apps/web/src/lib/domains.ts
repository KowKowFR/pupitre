import 'server-only';
import { CERTIFICATE_WARN_DAYS } from '@pupitre/core/proxy';
import { listRoutes, listServingProxies, listTargets } from '@pupitre/db';
import { proxyViewForUi, routeViewForUi, type RouteViewForUi } from './proxy';
import { currentLanguage } from '@/i18n/server';

const DAY_MS = 86_400_000;

/** One of the instance's domains, as the "Domains" page and its API return it. */
export type DomainRow = RouteViewForUi & {
  /** The proxy that serves it, or `null`: the machine no longer has one. */
  proxy: { name: string; description: string; waf: boolean } | null;
  /** The proxy's machine, when it is another's, or a remote proxy. */
  via: string | null;
  /**
   * Full days before the certificate's expiry, or since, if it expired (then
   * negative); `null` without a read certificate. Expired a few hours ago: `0`.
   */
  certificateDaysLeft: number | null;
  certificateExpired: boolean;
  /** The domain deserves a look: it does not answer, or its certificate is nearing expiry. */
  attention: boolean;
};

/**
 * All the instance's domains, with the proxy that serves them and their
 * certificate's state. Three reads, whatever their number: the routes, the
 * machines, and each one's proxy.
 */
export async function listDomains(now: number = Date.now()): Promise<DomainRow[]> {
  const language = await currentLanguage();
  const [routes, targets, proxies] = await Promise.all([
    listRoutes({}),
    listTargets(),
    listServingProxies(),
  ]);
  const nameOf = new Map(targets.map((target) => [target.id, target.name]));

  return routes
    .map((route) => {
      const serving = proxies.get(route.targetId);
      const view = serving ? proxyViewForUi(serving.proxy, language) : null;
      const expiresAt = route.certificate?.notAfter ? Date.parse(route.certificate.notAfter) : NaN;
      const left = route.tls && !Number.isNaN(expiresAt) ? expiresAt - now : null;
      // Toward zero both ways: expired two days and a bit ago is said "two days", not
      // three.
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
