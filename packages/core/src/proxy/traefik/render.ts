import { stringify } from 'yaml';
import type { TraefikFileConfig, TraefikKubernetesConfig } from '../model.js';
import type { ProxyRoute } from '../types.js';

/**
 * Ce que Pupitre dépose chez Traefik, sans effet de bord : un fichier de
 * configuration dynamique (mode `file`) ou des objets Kubernetes (mode
 * `kubernetes`). Testé à part, comme les rendus des drivers.
 *
 * Par domaine, deux routeurs au plus : l'un sur le point d'entrée HTTPS, avec
 * le résolveur de certificats ; l'autre sur HTTP, qui sert ou renvoie vers
 * HTTPS. Les noms sont préfixés par l'application : deux applications ne
 * peuvent pas se marcher dessus, et ce que Pupitre n'a pas posé ne porte pas
 * ce préfixe.
 */

export const ROUTE_MARK = 'Généré par Pupitre';

/** `blog.example.fr` → `blog-example-fr` : un fragment de nom de routeur. */
function hostKey(hostname: string): string {
  return hostname.replace(/[^a-z0-9]+/g, '-');
}

function hostRule(hostnames: string[]): string {
  return hostnames.map((host) => `Host(\`${host}\`)`).join(' || ');
}

type RouterPlan = { https: ProxyRoute[]; redirect: ProxyRoute[]; plain: ProxyRoute[] };

/**
 * Qui va où. Une route en HTTPS sans point d'entrée HTTPS est servie en HTTP :
 * le proxy ne sait pas faire mieux, et l'écran ne l'aura de toute façon pas
 * proposé.
 */
export function planRouters(routes: ProxyRoute[], httpsEntryPoint: string | null): RouterPlan {
  const plan: RouterPlan = { https: [], redirect: [], plain: [] };
  for (const route of routes) {
    if (route.tls && httpsEntryPoint) {
      plan.https.push(route);
      (route.redirectHttps ? plan.redirect : plan.plain).push(route);
    } else {
      plan.plain.push(route);
    }
  }
  return plan;
}

// ─── mode file ───────────────────────────────────────────────────────────────

export function traefikFileName(appSlug: string): string {
  return `${appSlug}.yml`;
}

export function renderTraefikFile(
  appSlug: string,
  routes: ProxyRoute[],
  upstreamUrl: string,
  config: TraefikFileConfig,
): string {
  const plan = planRouters(routes, config.entryPoints.https);
  const service = appSlug;
  const redirect = `${appSlug}-redirect-https`;
  const routers: Record<string, unknown> = {};

  for (const route of plan.https) {
    routers[`${appSlug}--${hostKey(route.hostname)}`] = {
      rule: hostRule([route.hostname]),
      entryPoints: [config.entryPoints.https],
      service,
      tls: config.certResolver ? { certResolver: config.certResolver } : {},
    };
  }
  for (const route of plan.redirect) {
    routers[`${appSlug}--${hostKey(route.hostname)}--http`] = {
      rule: hostRule([route.hostname]),
      entryPoints: [config.entryPoints.http],
      middlewares: [redirect],
      service,
    };
  }
  for (const route of plan.plain) {
    routers[`${appSlug}--${hostKey(route.hostname)}--http`] = {
      rule: hostRule([route.hostname]),
      entryPoints: [config.entryPoints.http],
      service,
    };
  }

  const document = {
    http: {
      routers,
      ...(plan.redirect.length > 0
        ? { middlewares: { [redirect]: { redirectScheme: { scheme: 'https', permanent: true } } } }
        : {}),
      services: { [service]: { loadBalancer: { servers: [{ url: upstreamUrl }] } } },
    },
  };
  return (
    `# ${ROUTE_MARK} pour « ${appSlug} » — ne pas éditer : le fichier est réécrit à chaque déploiement.\n` +
    stringify(document, { lineWidth: 0 })
  );
}

// ─── mode kubernetes ─────────────────────────────────────────────────────────

/** Les étiquettes qui disent « posé par Pupitre, pour cette application ». */
export function routeLabels(appSlug: string): Record<string, string> {
  return {
    'app.kubernetes.io/managed-by': 'pupitre',
    'app.kubernetes.io/part-of': appSlug,
    'pupitre.io/role': 'route',
  };
}

/**
 * Les noms des Ingress d'une application. `{slug}` reprend celui que le driver
 * K3s posait avant que les routes ne passent par le proxy : l'appliquer le
 * remplace au lieu d'en laisser un second sur le même domaine.
 */
export function ingressNames(appSlug: string): { https: string; redirect: string; plain: string } {
  return { https: appSlug, redirect: `${appSlug}-redirect`, plain: `${appSlug}-http` };
}

export const REDIRECT_MIDDLEWARE = 'pupitre-redirect-https';

type KubeObject = {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace: string;
    labels: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec: Record<string, unknown>;
};

export type TraefikKubernetesRender = {
  objects: KubeObject[];
  /** Les Ingress de l'application à retirer : prévus par le nommage, absents de ce rendu. */
  stale: string[];
};

export function renderTraefikIngresses(
  appSlug: string,
  routes: ProxyRoute[],
  upstream: { namespace: string; service: string; port: number },
  config: TraefikKubernetesConfig,
): TraefikKubernetesRender {
  const plan = planRouters(routes, config.entryPoints.https);
  const names = ingressNames(appSlug);
  const labels = routeLabels(appSlug);
  const objects: KubeObject[] = [];

  const ingress = (name: string, hosts: ProxyRoute[], annotations: Record<string, string>) => {
    objects.push({
      apiVersion: 'networking.k8s.io/v1',
      kind: 'Ingress',
      metadata: { name, namespace: upstream.namespace, labels, annotations },
      spec: {
        ingressClassName: config.ingressClass,
        rules: hosts.map((route) => ({
          host: route.hostname,
          http: {
            paths: [
              {
                path: '/',
                pathType: 'Prefix',
                backend: { service: { name: upstream.service, port: { number: upstream.port } } },
              },
            ],
          },
        })),
      },
    });
  };

  if (plan.https.length > 0 && config.entryPoints.https) {
    ingress(names.https, plan.https, {
      'traefik.ingress.kubernetes.io/router.entrypoints': config.entryPoints.https,
      'traefik.ingress.kubernetes.io/router.tls': 'true',
      ...(config.certResolver
        ? { 'traefik.ingress.kubernetes.io/router.tls.certresolver': config.certResolver }
        : {}),
    });
  }
  if (plan.redirect.length > 0) {
    objects.push({
      apiVersion: 'traefik.io/v1alpha1',
      kind: 'Middleware',
      metadata: { name: REDIRECT_MIDDLEWARE, namespace: upstream.namespace, labels },
      spec: { redirectScheme: { scheme: 'https', permanent: true } },
    });
    ingress(names.redirect, plan.redirect, {
      'traefik.ingress.kubernetes.io/router.entrypoints': config.entryPoints.http,
      'traefik.ingress.kubernetes.io/router.middlewares': `${upstream.namespace}-${REDIRECT_MIDDLEWARE}@kubernetescrd`,
    });
  }
  if (plan.plain.length > 0) {
    ingress(names.plain, plan.plain, {
      'traefik.ingress.kubernetes.io/router.entrypoints': config.entryPoints.http,
    });
  }

  const kept = new Set(
    objects.filter((object) => object.kind === 'Ingress').map((o) => o.metadata.name),
  );
  return { objects, stale: Object.values(names).filter((name) => !kept.has(name)) };
}

/**
 * En YAML 1.1, comme les manifestes du driver K3s : l'API Kubernetes lit avec un
 * analyseur 1.1, où `on` ou `y` sont des booléens — la sérialisation 1.1 met les
 * guillemets là où il en faut.
 */
export function serializeKubeObjects(objects: KubeObject[]): string {
  return objects.map((object) => stringify(object, { lineWidth: 0, version: '1.1' })).join('---\n');
}
