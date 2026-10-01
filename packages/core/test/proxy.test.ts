import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parse as parseYaml, parseAllDocuments } from 'yaml';
import { getDriver } from '../src/drivers/index.js';
import type { DriverContext } from '../src/drivers/types.js';
import { probeHostOf } from '../src/drivers/docker/driver.js';
import { renderComposeFile } from '../src/drivers/docker/render.js';
import { PROXY_POLICY_NAME, renderManifests } from '../src/drivers/k3s/render.js';
import {
  BUNKERWEB_PROBE,
  bunkerwebConfigSchema,
  describeProxy,
  hostnameProblem,
  interpretRouteProbe,
  interpretTraefikCluster,
  interpretReach,
  interpretTraefikContainer,
  isIPv4,
  isPrivateAddress,
  normalizePeer,
  parseCertificate,
  parseIngressClasses,
  parseRegistry,
  planServices,
  proxyAcme,
  proxyCapabilities,
  reachCandidates,
  readTraefik,
  renderHelmChartConfig,
  renderBunkerwebCompose,
  renderManagedCompose,
  renderTraefikFile,
  renderTraefikIngresses,
  renderTraefikRemoteIngresses,
  REMOTE_NAMESPACE,
  routeListSchema,
  serializeKubeObjects,
  serviceVariables,
  staticConfigFromArgs,
  staticConfigFromEnv,
  staticConfigFromYaml,
  traefikConfigSchema,
  TRAEFIK_PROBE,
  wafPreset,
  type ProxyRoute,
  type TraefikFileConfig,
  type TraefikKubernetesConfig,
} from '../src/proxy/index.js';
import { parseAppSpec } from '../src/spec/index.js';

const fileConfig: TraefikFileConfig = traefikConfigSchema.parse({
  mode: 'file',
  certResolver: 'pupitre',
}) as TraefikFileConfig;

const kubeConfig: TraefikKubernetesConfig = traefikConfigSchema.parse({
  mode: 'kubernetes',
  certResolver: 'pupitre',
}) as TraefikKubernetesConfig;

const secure: ProxyRoute = {
  hostname: 'blog.example.fr',
  tls: true,
  redirectHttps: true,
  waf: 'block',
};
const secureNoRedirect: ProxyRoute = {
  hostname: 'api.example.fr',
  tls: true,
  redirectHttps: false,
  waf: 'detect',
};
const plain: ProxyRoute = {
  hostname: 'old.example.fr',
  tls: false,
  redirectHttps: false,
  waf: 'off',
};

describe('les noms de domaine', () => {
  it('normalise et refuse ce qui ne se route pas', () => {
    assert.equal(hostnameProblem('Blog.Example.FR.'), null);
    assert.match(hostnameProblem('localhost') ?? '', /point/);
    assert.match(hostnameProblem('192.168.1.10') ?? '', /IP/);
    assert.match(hostnameProblem('*.example.fr') ?? '', /joker/);
    assert.match(hostnameProblem('-bad.example.fr') ?? '', /invalide/);
  });

  it('refuse deux fois le même domaine pour une application', () => {
    const parsed = routeListSchema.safeParse([{ hostname: 'a.fr' }, { hostname: 'A.fr' }]);
    assert.equal(parsed.success, false);
    const ok = routeListSchema.parse([{ hostname: 'Blog.Example.fr' }]);
    assert.deepEqual(ok, [
      { hostname: 'blog.example.fr', tls: true, redirectHttps: true, waf: 'block' },
    ]);
  });

  it('dit ce que le proxy sait faire', () => {
    assert.deepEqual(proxyCapabilities('traefik', fileConfig), {
      autoTls: true,
      https: true,
      redirectHttps: true,
      waf: false,
      remoteUpstream: 'any',
    });
    assert.equal(proxyCapabilities('traefik', kubeConfig).remoteUpstream, 'ipv4');
    const noAcme = proxyCapabilities('traefik', { mode: 'file', certResolver: null });
    assert.equal(noAcme.autoTls, false);
    assert.equal(noAcme.https, true);
  });
});

describe('Traefik — fichier de routes', () => {
  const yaml = renderTraefikFile(
    'blog',
    [secure, secureNoRedirect, plain],
    'http://127.0.0.1:30001',
    fileConfig,
  );
  const document = parseYaml(yaml) as {
    http: {
      routers: Record<
        string,
        {
          rule: string;
          entryPoints: string[];
          middlewares?: string[];
          tls?: unknown;
          service: string;
        }
      >;
      middlewares?: Record<string, unknown>;
      services: Record<string, { loadBalancer: { servers: Array<{ url: string }> } }>;
    };
  };

  it('porte la marque de Pupitre et le nom de l’application', () => {
    assert.match(yaml, /^# Généré par Pupitre pour « blog »/);
    for (const name of Object.keys(document.http.routers)) assert.ok(name.startsWith('blog--'));
  });

  it('sert en HTTPS avec le résolveur, et renvoie HTTP vers HTTPS', () => {
    const https = document.http.routers['blog--blog-example-fr'];
    assert.deepEqual(https?.entryPoints, ['websecure']);
    assert.deepEqual(https?.tls, { certResolver: 'pupitre' });
    assert.equal(https?.rule, 'Host(`blog.example.fr`)');
    const redirect = document.http.routers['blog--blog-example-fr--http'];
    assert.deepEqual(redirect?.middlewares, ['blog-redirect-https']);
    assert.ok(document.http.middlewares?.['blog-redirect-https']);
  });

  it('sert aussi en HTTP quand la redirection n’est pas voulue, ou sans HTTPS', () => {
    assert.equal(document.http.routers['blog--api-example-fr--http']?.middlewares, undefined);
    assert.equal(document.http.routers['blog--old-example-fr'], undefined, 'pas de routeur HTTPS');
    assert.deepEqual(document.http.routers['blog--old-example-fr--http']?.entryPoints, ['web']);
  });

  it('joint l’application par l’amont donné', () => {
    assert.deepEqual(document.http.services.blog?.loadBalancer.servers, [
      { url: 'http://127.0.0.1:30001' },
    ]);
  });

  it('sans point d’entrée HTTPS, tout passe en HTTP', () => {
    const config = { ...fileConfig, entryPoints: { http: 'web', https: null } };
    const only = parseYaml(renderTraefikFile('blog', [secure], 'http://127.0.0.1:1', config)) as {
      http: { routers: Record<string, unknown>; middlewares?: unknown };
    };
    assert.deepEqual(Object.keys(only.http.routers), ['blog--blog-example-fr--http']);
    assert.equal(only.http.middlewares, undefined);
  });
});

describe('Traefik — Ingress dans le cluster', () => {
  const upstream = { namespace: 'app-blog', service: 'front', port: 3000 };

  it('pose un Ingress HTTPS, un de redirection et un en clair, nommés par l’application', () => {
    const rendered = renderTraefikIngresses(
      'blog',
      [secure, secureNoRedirect, plain],
      upstream,
      kubeConfig,
    );
    const ingresses = rendered.objects.filter((object) => object.kind === 'Ingress');
    assert.deepEqual(
      ingresses.map((object) => object.metadata.name),
      ['blog', 'blog-redirect', 'blog-http'],
    );
    const https = ingresses[0]!;
    assert.equal(
      https.metadata.annotations?.['traefik.ingress.kubernetes.io/router.tls.certresolver'],
      'pupitre',
    );
    assert.equal(
      https.metadata.annotations?.['traefik.ingress.kubernetes.io/router.entrypoints'],
      'websecure',
    );
    assert.equal(https.metadata.labels['app.kubernetes.io/managed-by'], 'pupitre');
    assert.equal(
      ingresses[1]!.metadata.annotations?.['traefik.ingress.kubernetes.io/router.middlewares'],
      'app-blog-pupitre-redirect-https@kubernetescrd',
    );
    assert.ok(rendered.objects.some((object) => object.kind === 'Middleware'));
    assert.deepEqual(rendered.stale, []);
  });

  it('retire ce qui n’a plus lieu d’être', () => {
    const rendered = renderTraefikIngresses('blog', [plain], upstream, kubeConfig);
    assert.deepEqual(rendered.stale.sort(), ['blog', 'blog-redirect']);
    assert.ok(!rendered.objects.some((object) => object.kind === 'Middleware'));
  });

  it('sérialise en YAML 1.1 : « true » reste une chaîne pour l’API', () => {
    const text = serializeKubeObjects(
      renderTraefikIngresses('blog', [secure], upstream, kubeConfig).objects,
    );
    assert.match(text, /router\.tls: "true"/);
    const documents = parseAllDocuments(text).map(
      (document) => document.toJSON() as { kind: string },
    );
    assert.deepEqual(
      documents.map((document) => document.kind),
      ['Ingress', 'Middleware', 'Ingress'],
    );
  });
});

describe('Traefik — lire une installation existante', () => {
  it('fusionne arguments, environnement et fichier', () => {
    const config = staticConfigFromYaml(
      'entryPoints:\n  web:\n    address: ":80"\n  websecure:\n    address: ":443"\nproviders:\n  file:\n    directory: /etc/traefik/dynamic\n',
    );
    staticConfigFromEnv(
      ['TRAEFIK_CERTIFICATESRESOLVERS_LE_ACME_EMAIL=a@b.fr', 'PATH=/bin'],
      config,
    );
    staticConfigFromArgs(['--log.level=INFO', '--providers.file.watch=true'], config);
    const read = readTraefik(config);
    assert.deepEqual(read.entryPoints, { http: 'web', https: 'websecure' });
    assert.deepEqual(read.resolvers, ['le']);
    assert.equal(read.fileDirectory, '/etc/traefik/dynamic');
  });

  it('reconnaît les points d’entrée par leur port quand ils ont d’autres noms', () => {
    const read = readTraefik(
      staticConfigFromArgs([
        '--entrypoints.http.address=:80',
        '--entrypoints.https.address=:443/tcp',
      ]),
    );
    assert.deepEqual(read.entryPoints, { http: 'http', https: 'https' });
  });

  it('traduit le dossier du conteneur en chemin de la machine', () => {
    const finding = interpretTraefikContainer(
      {
        Name: '/traefik',
        Args: [
          '--entrypoints.web.address=:80',
          '--entrypoints.websecure.address=:443',
          '--providers.file.directory=/conf/dyn',
          '--certificatesresolvers.le.acme.email=a@b.fr',
        ],
        Mounts: [{ Source: '/srv/traefik', Destination: '/conf' }],
        HostConfig: { NetworkMode: 'host' },
      },
      null,
    );
    assert.equal(finding.config?.directory, '/srv/traefik/dyn');
    assert.equal(finding.config?.upstreamHost, '127.0.0.1');
    assert.equal(finding.config?.certResolver, 'le');
    assert.deepEqual(finding.warnings, []);
  });

  it('prévient quand Traefik est en réseau bridge, ou sans dossier monté', () => {
    const bridged = interpretTraefikContainer(
      {
        Args: ['--entrypoints.web.address=:80', '--providers.file.directory=/dyn'],
        Mounts: [{ Source: '/opt/dyn', Destination: '/dyn' }],
        HostConfig: { NetworkMode: 'proxy' },
        NetworkSettings: { Networks: { proxy: { Gateway: '172.20.0.1' } } },
      },
      null,
    );
    assert.equal(bridged.config?.upstreamHost, '172.20.0.1');
    assert.ok(bridged.warnings.some((warning) => warning.includes('passerelle 172.20.0.1')));

    const unmounted = interpretTraefikContainer(
      { Args: ['--entrypoints.web.address=:80', '--providers.file.directory=/dyn'] },
      null,
    );
    assert.equal(unmounted.config, null);
    assert.ok(unmounted.warnings.some((warning) => warning.includes("n'est pas monté")));

    const labelsOnly = interpretTraefikContainer({ Args: ['--providers.docker=true'] }, null);
    assert.equal(labelsOnly.config, null);
    assert.match(labelsOnly.warnings[0] ?? '', /providers\.file\.directory/);
  });

  it('lit le Traefik de K3s : classe, points d’entrée, résolveurs', () => {
    const classes = parseIngressClasses(
      JSON.stringify({
        items: [
          { metadata: { name: 'traefik' }, spec: { controller: 'traefik.io/ingress-controller' } },
          { metadata: { name: 'nginx' }, spec: { controller: 'k8s.io/ingress-nginx' } },
        ],
      }),
    );
    assert.deepEqual(classes, ['traefik']);
    const finding = interpretTraefikCluster(classes, {
      namespace: 'kube-system',
      args: ['--entryPoints.web.address=:8000/tcp', '--entryPoints.websecure.address=:8443/tcp'],
    });
    assert.equal(finding.config?.entryPoints.http, 'web');
    assert.equal(finding.config?.entryPoints.https, 'websecure');
    assert.equal(finding.config?.certResolver, null);
    assert.ok(finding.warnings.some((warning) => warning.includes('ACME')));
  });
});

describe('la sonde d’une route', () => {
  const now = Date.parse('2026-10-01T12:00:00Z');

  it('juge une route qui répond, redirection et certificat compris', () => {
    const probe = interpretRouteProbe(
      secure,
      [
        'probe http 308 0',
        'probe https 200 0',
        'cert subject=CN = blog.example.fr',
        "cert issuer=C = US, O = Let's Encrypt, CN = R11",
        'cert notAfter=Dec 30 12:00:00 2026 GMT',
      ].join('\n'),
      TRAEFIK_PROBE,
      now,
    );
    assert.equal(probe.ok, true);
    assert.equal(probe.certificate.status, 'valid');
    assert.equal(probe.certificate.notAfter, '2026-12-30T12:00:00.000Z');
  });

  it('distingue route absente, application muette, proxy éteint, redirection manquante', () => {
    assert.match(
      interpretRouteProbe(plain, 'probe http 404 1', TRAEFIK_PROBE, now).detail,
      /ne connaît pas/,
    );
    assert.match(
      interpretRouteProbe(plain, 'probe http 502 0', TRAEFIK_PROBE, now).detail,
      /ne joint pas/,
    );
    assert.match(
      interpretRouteProbe(plain, 'probe http 000 0', TRAEFIK_PROBE, now).detail,
      /ne répond pas/,
    );
    assert.match(
      interpretRouteProbe(secure, 'probe http 200 0\nprobe https 200 0', TRAEFIK_PROBE, now).detail,
      /redirection/,
    );
    // Une 404 de l'application elle-même n'est pas une route absente.
    assert.equal(interpretRouteProbe(plain, 'probe http 404 0', TRAEFIK_PROBE, now).ok, true);
  });

  it('reconnaît le certificat par défaut de Traefik, et un certificat expiré', () => {
    assert.equal(
      parseCertificate(
        'curl subject=CN=TRAEFIK DEFAULT CERT\ncurl issuer=CN=TRAEFIK DEFAULT CERT',
        TRAEFIK_PROBE,
        now,
      ).status,
      'pending',
    );
    assert.equal(
      parseCertificate(
        'cert subject=CN = a.fr\ncert issuer=CN = R11\ncert notAfter=Jan  1 00:00:00 2026 GMT',
        TRAEFIK_PROBE,
        now,
      ).status,
      'invalid',
    );
    assert.equal(parseCertificate('', TRAEFIK_PROBE, now).status, 'unknown');
  });
});

describe('Traefik installé par Pupitre', () => {
  const acme = {
    email: 'ops@example.fr',
    server: 'custom' as const,
    customUrl: 'https://pebble:14000/dir',
    caCertificate: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
  };

  it('en conteneur : réseau hôte, routes en lecture seule, pas de socket Docker', () => {
    const compose = parseYaml(renderManagedCompose('/opt/bootstrap', acme)) as {
      services: {
        traefik: {
          network_mode: string;
          command: string[];
          volumes: string[];
          environment?: Record<string, string>;
        };
      };
    };
    const traefik = compose.services.traefik;
    assert.equal(traefik.network_mode, 'host');
    assert.ok(
      traefik.command.includes(
        '--certificatesresolvers.pupitre.acme.caserver=https://pebble:14000/dir',
      ),
    );
    assert.ok(traefik.volumes.includes('/opt/bootstrap/proxy/dynamic:/etc/traefik/dynamic:ro'));
    assert.ok(!traefik.volumes.some((volume) => volume.includes('docker.sock')));
    assert.equal(traefik.environment?.LEGO_CA_CERTIFICATES, '/etc/traefik/acme-ca.pem');
  });

  it('dans K3s : une HelmChartConfig marquée, et l’autorité ACME en ConfigMap', () => {
    const documents = parseAllDocuments(renderHelmChartConfig('kube-system', acme)).map(
      (document) =>
        document.toJSON() as {
          kind: string;
          metadata: { annotations: Record<string, string> };
          spec?: { valuesContent: string };
        },
    );
    assert.deepEqual(
      documents.map((document) => document.kind),
      ['ConfigMap', 'HelmChartConfig'],
    );
    const helm = documents[1]!;
    assert.equal(helm.metadata.annotations['pupitre.io/managed-by'], 'pupitre');
    const values = parseYaml(helm.spec!.valuesContent) as {
      additionalArguments: string[];
      persistence: { enabled: boolean };
    };
    assert.ok(
      values.additionalArguments.includes(
        '--certificatesresolvers.pupitre.acme.httpchallenge.entrypoint=web',
      ),
    );
    assert.equal(values.persistence.enabled, true);
  });
});

describe('l’amont, dit par le driver', () => {
  const spec = parseAppSpec({
    name: 'blog',
    version: '1.0.0',
    services: [
      { name: 'front', source: { type: 'image', ref: 'nginx:alpine' }, port: 8080, exposed: true },
    ],
  });
  const ctx = { spec, appSlug: 'blog' } as unknown as DriverContext;

  it('Compose : le port publié ; K3s : le Service du point d’entrée', () => {
    assert.deepEqual(getDriver('docker').upstream(ctx, 30001), { kind: 'port', port: 30001 });
    assert.equal(getDriver('docker').upstream(ctx, null), null);
    assert.deepEqual(getDriver('k3s').upstream(ctx, null), {
      kind: 'kubernetes',
      namespace: 'app-blog',
      service: 'front',
      port: 8080,
    });
  });

  it('K3s : le NodePort, quand un proxy hors du cluster doit la joindre', () => {
    assert.deepEqual(getDriver('k3s').upstream(ctx, 30001), { kind: 'port', port: 30001 });
  });

  it('Compose publie sur la boucle locale quand un proxy de la machine sert l’application', () => {
    const compose = renderComposeFile({
      spec,
      appSlug: 'blog',
      publishedPort: 30001,
      publishAddress: '127.0.0.1',
    });
    assert.deepEqual(compose.services.front?.ports, ['127.0.0.1:30001:8080']);
    const open = renderComposeFile({ spec, appSlug: 'blog', publishedPort: 30001 });
    assert.deepEqual(open.services.front?.ports, ['30001:8080']);
  });
});

describe('le proxy central — une machine servie par le proxy d’une autre', () => {
  const spec = parseAppSpec({
    name: 'blog',
    version: '1.0.0',
    services: [
      { name: 'front', source: { type: 'image', ref: 'nginx:alpine' }, port: 8080, exposed: true },
      { name: 'cache', source: { type: 'image', ref: 'redis:7' }, port: 6379 },
    ],
  });

  it('distingue les adresses privées, celles où le trafic en clair reste chez soi', () => {
    for (const address of ['10.0.0.12', '192.168.1.4', '172.20.0.3', '100.72.1.1', 'fd12::1'])
      assert.equal(isPrivateAddress(address), true, address);
    for (const address of ['51.15.20.1', '172.32.0.1', '2001:db8::1', 'srv.example.fr'])
      assert.equal(isPrivateAddress(address), false, address);
    assert.equal(isIPv4('10.0.0.12'), true);
    assert.equal(isIPv4('10.0.0.256'), false);
    assert.equal(isIPv4('srv.example.fr'), false);
  });

  it('Traefik en fichier : l’amont pointe l’autre machine', () => {
    const yaml = renderTraefikFile(
      'blog--t1a2b3c4d',
      [plain],
      'http://10.0.0.12:30001',
      fileConfig,
    );
    const document = parseYaml(yaml) as {
      http: { services: Record<string, { loadBalancer: { servers: Array<{ url: string }> } }> };
    };
    assert.deepEqual(document.http.services['blog--t1a2b3c4d']?.loadBalancer.servers, [
      { url: 'http://10.0.0.12:30001' },
    ]);
  });

  it('Traefik de cluster : un Service sans sélecteur, l’adresse en EndpointSlice', () => {
    const rendered = renderTraefikRemoteIngresses(
      'blog--t1a2b3c4d',
      [secure, plain],
      { host: '10.0.0.12', port: 30001 },
      kubeConfig,
    );
    const byKind = (kind: string) => rendered.objects.filter((object) => object.kind === kind);
    assert.equal(byKind('Namespace')[0]?.metadata.name, REMOTE_NAMESPACE);
    const service = byKind('Service')[0] as unknown as {
      metadata: { name: string; namespace: string };
      spec: { selector?: unknown; ports: Array<{ port: number }> };
    };
    assert.equal(service.metadata.name, 'blog--t1a2b3c4d');
    assert.equal(service.spec.selector, undefined, 'pas de sélecteur : pas de pod derrière');
    const slice = byKind('EndpointSlice')[0] as unknown as {
      metadata: { labels: Record<string, string> };
      addressType: string;
      endpoints: Array<{ addresses: string[] }>;
      ports: Array<{ name: string; port: number }>;
    };
    assert.equal(slice.metadata.labels['kubernetes.io/service-name'], 'blog--t1a2b3c4d');
    assert.equal(slice.addressType, 'IPv4');
    assert.deepEqual(slice.endpoints[0]?.addresses, ['10.0.0.12']);
    assert.deepEqual(slice.ports, [{ name: 'http', port: 30001, protocol: 'TCP' }]);
    const ingresses = byKind('Ingress') as unknown as Array<{
      metadata: { namespace: string };
      spec: { rules: Array<{ http: { paths: Array<{ backend: unknown }> } }> };
    }>;
    assert.ok(ingresses.length > 0);
    for (const ingress of ingresses) {
      assert.equal(ingress.metadata.namespace, REMOTE_NAMESPACE);
      assert.deepEqual(ingress.spec.rules[0]?.http.paths[0]?.backend, {
        service: { name: 'blog--t1a2b3c4d', port: { number: 30001 } },
      });
    }
  });

  it('K3s : le point d’entrée seul en NodePort, réservé au proxy par une NetworkPolicy', () => {
    const manifests = renderManifests({
      spec,
      appSlug: 'blog',
      publishedPort: 30001,
      allowFrom: '10.0.0.2',
    });
    const services = manifests.filter((manifest) => manifest.kind === 'Service') as Array<{
      metadata: { name: string };
      spec: { type: string; externalTrafficPolicy?: string; ports: Array<{ nodePort?: number }> };
    }>;
    const front = services.find((service) => service.metadata.name === 'front');
    const cache = services.find((service) => service.metadata.name === 'cache');
    assert.equal(front?.spec.type, 'NodePort');
    assert.equal(front?.spec.ports[0]?.nodePort, 30001);
    assert.equal(front?.spec.externalTrafficPolicy, 'Local', 'l’adresse d’origine reste lisible');
    assert.equal(cache?.spec.type, 'ClusterIP');

    const policy = manifests.find((manifest) => manifest.kind === 'NetworkPolicy') as unknown as {
      metadata: { name: string };
      spec: {
        podSelector: { matchLabels: Record<string, string> };
        ingress: Array<{ from: unknown[]; ports?: unknown[] }>;
      };
    };
    assert.equal(policy.metadata.name, PROXY_POLICY_NAME);
    assert.equal(policy.spec.podSelector.matchLabels['app.kubernetes.io/name'], 'front');
    assert.deepEqual(policy.spec.ingress, [
      { from: [{ podSelector: {} }] },
      { from: [{ ipBlock: { cidr: '10.0.0.2/32' } }], ports: [{ protocol: 'TCP', port: 8080 }] },
    ]);
  });

  it('K3s : sans proxy distant, ni NodePort ni NetworkPolicy', () => {
    const manifests = renderManifests({ spec, appSlug: 'blog' });
    assert.ok(
      manifests
        .filter((manifest) => manifest.kind === 'Service')
        .every((manifest) => (manifest.spec as { type: string }).type === 'ClusterIP'),
    );
    assert.equal(
      manifests.some((manifest) => manifest.kind === 'NetworkPolicy'),
      false,
    );
  });

  it('Compose : publié sur l’adresse privée que joint le proxy, sondé là', () => {
    const compose = renderComposeFile({
      spec,
      appSlug: 'blog',
      publishedPort: 30001,
      publishAddress: '10.0.0.12',
    });
    assert.deepEqual(compose.services.front?.ports, ['10.0.0.12:30001:8080']);
    assert.equal(probeHostOf('10.0.0.12:30001'), '10.0.0.12');
    assert.equal(probeHostOf('0.0.0.0:30001'), '127.0.0.1');
    assert.equal(probeHostOf('[::]:30001'), '127.0.0.1');
    assert.equal(probeHostOf('127.0.0.1:30001'), '127.0.0.1');
    assert.equal(probeHostOf(null), '127.0.0.1');
  });
});

describe('le proxy central — la connexion éprouvée entre les deux machines', () => {
  it('tire le port d’essai dans la plage des applications, hors des réservations', () => {
    let seed = 0;
    const random = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
    const ports = reachCandidates({ min: 30000, max: 30009 }, new Set([30000, 30001]), 5, random);
    assert.ok(ports.length > 0);
    for (const port of ports) {
      assert.ok(port >= 30000 && port <= 30009, String(port));
      assert.ok(port !== 30000 && port !== 30001, String(port));
    }
    assert.equal(new Set(ports).size, ports.length, 'pas deux fois le même');
  });

  it('parcourt une plage presque pleine, et n’invente rien quand elle l’est', () => {
    const full = new Set([30000, 30001, 30002]);
    assert.deepEqual(
      reachCandidates({ min: 30000, max: 30003 }, full, 3, () => 0),
      [30003],
    );
    full.add(30003);
    assert.deepEqual(reachCandidates({ min: 30000, max: 30003 }, full), []);
  });

  it('lit l’adresse d’arrivée, IPv4 vue par un écouteur IPv6 comprise', () => {
    assert.equal(normalizePeer('::ffff:172.21.0.6\n'), '172.21.0.6');
    assert.equal(normalizePeer('10.0.0.2'), '10.0.0.2');
    assert.equal(normalizePeer('fd00::2'), 'fd00::2');
    assert.equal(normalizePeer(''), null);
  });

  it('dit ce qui bloque : rien, un refus, un silence, une autre machine', () => {
    const base = { token: 'abc123', address: '10.0.0.12', port: 30042, proxyName: 'srv-1' };
    assert.equal(interpretReach({ ...base, curlCode: 0, body: 'abc123\n\ncurl=0' }).failure, null);
    const refused = interpretReach({ ...base, curlCode: 7, body: '' });
    assert.equal(refused.failure, 'refused');
    assert.match(refused.detail, /10\.0\.0\.12:30042 refuse/);
    const silent = interpretReach({ ...base, curlCode: 28, body: '' });
    assert.equal(silent.failure, 'timeout');
    assert.match(silent.detail, /groupe de sécurité/);
    assert.equal(
      interpretReach({ ...base, curlCode: 0, body: '<html>nginx</html>' }).failure,
      'mismatch',
    );
    assert.match(interpretReach({ ...base, curlCode: 52, body: '' }).detail, /coupe sans réponse/);
    assert.equal(interpretReach({ ...base, curlCode: 6, body: '' }).failure, 'error');
  });
});

describe('BunkerWeb — la connexion et ce qu’elle permet', () => {
  const config = bunkerwebConfigSchema.parse({
    container: 'pupitre-bunkerweb',
    apiContainer: 'pupitre-bunkerweb',
    upstreamHost: '172.17.0.1',
    managed: true,
    acme: { email: 'ops@example.fr', server: 'staging' },
  });

  it('est un WAF qui sert en HTTPS, et joint toute machine', () => {
    assert.deepEqual(proxyCapabilities('bunkerweb', config), {
      autoTls: true,
      https: true,
      redirectHttps: true,
      waf: true,
      remoteUpstream: 'any',
    });
    assert.match(
      describeProxy('bunkerweb', config),
      /BunkerWeb · conteneur pupitre-bunkerweb · WAF/,
    );
    assert.deepEqual(proxyAcme('bunkerweb', config), {
      email: 'ops@example.fr',
      server: 'staging',
    });
    assert.equal(proxyCapabilities('bunkerweb', { ...config, acme: null }).autoTls, false);
  });

  it('refuse une autorité que BunkerWeb ne sait pas interroger', () => {
    const custom = bunkerwebConfigSchema.safeParse({
      ...config,
      acme: { email: 'ops@example.fr', server: 'custom', customUrl: 'https://acme.local/dir' },
    });
    assert.equal(custom.success, false);
  });

  it('reconnaît sa page par défaut, servie en 200, et son certificat d’attente', () => {
    const now = Date.parse('2026-10-01T12:00:00Z');
    const absent = interpretRouteProbe(plain, 'probe http 200 1', BUNKERWEB_PROBE, now);
    assert.equal(absent.ok, false);
    assert.match(absent.detail, /ne connaît pas ce domaine \(200\)/);
    const pending = interpretRouteProbe(
      secure,
      [
        'probe http 301 0',
        'probe https 200 0',
        'cert subject=C=AU, ST=Some-State, O=Internet Widgits Pty Ltd, CN=www.example.org',
        'cert issuer=C=AU, ST=Some-State, O=Internet Widgits Pty Ltd, CN=www.example.org',
      ].join('\n'),
      BUNKERWEB_PROBE,
      now,
    );
    assert.equal(pending.ok, true);
    assert.equal(pending.certificate.status, 'pending');
  });
});

describe('BunkerWeb — un service par domaine', () => {
  it('relaie vers l’amont, certificat et redirection selon la route', () => {
    const variables = serviceVariables({
      route: secure,
      upstream: 'http://172.17.0.1:30001',
      acme: { email: 'ops@example.fr', server: 'staging' },
    });
    assert.equal(variables.SERVER_NAME, 'blog.example.fr');
    assert.equal(variables.USE_REVERSE_PROXY, 'yes');
    assert.equal(variables.REVERSE_PROXY_HOST, 'http://172.17.0.1:30001');
    assert.equal(variables.AUTO_LETS_ENCRYPT, 'yes');
    assert.equal(variables.USE_LETS_ENCRYPT_STAGING, 'yes');
    assert.equal(variables.LETS_ENCRYPT_SERVER, 'letsencrypt');
    assert.equal(variables.EMAIL_LETS_ENCRYPT, 'ops@example.fr');
    assert.equal(variables.REDIRECT_HTTP_TO_HTTPS, 'yes');
    // Les sondes passent la liste blanche par un en-tête secret, jamais par
    // l'adresse : la passerelle Docker est aussi celle des visiteurs IPv6.
    assert.equal(variables.WHITELIST_HEADER_NAME, 'X-Pupitre-Probe');
    assert.equal(variables.WHITELIST_HEADER_VALUE, '^__PUPITRE_PROBE_SECRET__$');
    assert.equal(variables.WHITELIST_IP, undefined);

    const noRedirect = serviceVariables({
      route: secureNoRedirect,
      upstream: 'http://10.0.0.12:30002',
      acme: { email: 'ops@example.fr', server: 'zerossl' },
    });
    assert.equal(noRedirect.REDIRECT_HTTP_TO_HTTPS, 'no');
    assert.equal(noRedirect.AUTO_REDIRECT_HTTP_TO_HTTPS, 'no');
    assert.equal(noRedirect.LETS_ENCRYPT_SERVER, 'zerossl');

    const http = serviceVariables({ route: plain, upstream: 'http://x:1', acme: null });
    assert.equal(http.AUTO_LETS_ENCRYPT, 'no');
    assert.equal(http.GENERATE_SELF_SIGNED_SSL, 'no');
    const selfSigned = serviceVariables({
      route: secure,
      upstream: 'http://x:1',
      acme: null,
    });
    assert.equal(selfSigned.AUTO_LETS_ENCRYPT, 'no');
    assert.equal(selfSigned.GENERATE_SELF_SIGNED_SSL, 'yes');
  });

  it('trois préréglages : bloquer, détecter, relayer — jamais les limites d’un site vitrine', () => {
    const block = wafPreset('block');
    assert.equal(block.SECURITY_MODE, 'block');
    assert.equal(block.MODSECURITY_SEC_RULE_ENGINE, 'On');
    assert.equal(block.USE_MODSECURITY_CRS, 'yes');
    assert.notEqual(block.LIMIT_REQ_RATE, '2r/s');
    assert.doesNotMatch(block.BAD_BEHAVIOR_STATUS_CODES ?? '', /429/);
    assert.match(block.ALLOWED_METHODS ?? '', /PUT.*DELETE/);
    assert.equal(block.LIMIT_CONN_MAX_HTTP1, '100');
    assert.equal(
      wafPreset('detect').USE_LIMIT_CONN,
      'no',
      'nginx ne sait pas seulement journaliser',
    );
    const detect = wafPreset('detect');
    assert.equal(detect.SECURITY_MODE, 'detect');
    assert.equal(detect.MODSECURITY_SEC_RULE_ENGINE, 'DetectionOnly');
    const off = wafPreset('off');
    assert.equal(off.USE_MODSECURITY, 'no');
    assert.equal(off.USE_LIMIT_REQ, 'no');
    assert.equal(off.USE_BAD_BEHAVIOR, 'no');
  });

  it('ne touche qu’à ce qu’il a posé, et laisse à l’autre application ce qu’elle a repris', () => {
    const plan = planServices({
      wanted: ['a.fr', 'b.fr', 'c.fr'],
      previous: ['a.fr', 'old.fr', 'moved.fr'],
      existing: ['a.fr', 'c.fr', 'old.fr', 'moved.fr', 'manual.fr'],
      others: ['moved.fr'],
    });
    assert.deepEqual(plan.create, ['b.fr']);
    assert.deepEqual(plan.update, ['a.fr']);
    assert.deepEqual(plan.foreign, ['c.fr'], 'un service fait à la main n’est pas écrasé');
    assert.deepEqual(plan.remove, ['old.fr'], 'moved.fr est désormais à une autre application');
  });

  it('lit son registre, même abîmé', () => {
    assert.deepEqual(parseRegistry('{"hostnames":["a.fr",3]}'), { hostnames: ['a.fr'] });
    assert.deepEqual(parseRegistry('pas du json'), { hostnames: [] });
    assert.deepEqual(parseRegistry(null), { hostnames: [] });
  });

  it('s’installe sans jeton dans le fichier Compose, API ouverte, interface fermée', () => {
    const compose = parseYaml(renderBunkerwebCompose()) as {
      services: {
        bunkerweb: { ports: string[]; environment: Record<string, string>; env_file: string[] };
      };
    };
    const service = compose.services.bunkerweb;
    assert.deepEqual(service.ports, ['80:8080/tcp', '443:8443/tcp']);
    assert.equal(service.environment.SERVICE_API, 'yes');
    assert.equal(service.environment.SERVICE_UI, 'no');
    assert.deepEqual(service.env_file, ['./api.env']);
    assert.doesNotMatch(renderBunkerwebCompose(), /API_TOKEN/);
    assert.equal(
      service.environment.SERVER_NAMES_HASH_BUCKET_SIZE,
      '256',
      'un domaine long ne fait pas refuser la configuration',
    );
  });
});
