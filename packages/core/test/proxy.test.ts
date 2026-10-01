import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parse as parseYaml, parseAllDocuments } from 'yaml';
import { getDriver } from '../src/drivers/index.js';
import type { DriverContext } from '../src/drivers/types.js';
import { renderComposeFile } from '../src/drivers/docker/render.js';
import {
  hostnameProblem,
  interpretRouteProbe,
  interpretTraefikCluster,
  interpretTraefikContainer,
  parseCertificate,
  parseIngressClasses,
  proxyCapabilities,
  readTraefik,
  renderHelmChartConfig,
  renderManagedCompose,
  renderTraefikFile,
  renderTraefikIngresses,
  routeListSchema,
  serializeKubeObjects,
  staticConfigFromArgs,
  staticConfigFromEnv,
  staticConfigFromYaml,
  traefikConfigSchema,
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

const secure: ProxyRoute = { hostname: 'blog.example.fr', tls: true, redirectHttps: true };
const secureNoRedirect: ProxyRoute = {
  hostname: 'api.example.fr',
  tls: true,
  redirectHttps: false,
};
const plain: ProxyRoute = { hostname: 'old.example.fr', tls: false, redirectHttps: false };

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
    assert.deepEqual(ok, [{ hostname: 'blog.example.fr', tls: true, redirectHttps: true }]);
  });

  it('dit ce que le proxy sait faire', () => {
    assert.deepEqual(proxyCapabilities('traefik', fileConfig), {
      autoTls: true,
      https: true,
      redirectHttps: true,
    });
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
      now,
    );
    assert.equal(probe.ok, true);
    assert.equal(probe.certificate.status, 'valid');
    assert.equal(probe.certificate.notAfter, '2026-12-30T12:00:00.000Z');
  });

  it('distingue route absente, application muette, proxy éteint, redirection manquante', () => {
    assert.match(interpretRouteProbe(plain, 'probe http 404 1', now).detail, /ne connaît pas/);
    assert.match(interpretRouteProbe(plain, 'probe http 502 0', now).detail, /ne joint pas/);
    assert.match(interpretRouteProbe(plain, 'probe http 000 0', now).detail, /ne répond pas/);
    assert.match(
      interpretRouteProbe(secure, 'probe http 200 0\nprobe https 200 0', now).detail,
      /redirection/,
    );
    // Une 404 de l'application elle-même n'est pas une route absente.
    assert.equal(interpretRouteProbe(plain, 'probe http 404 0', now).ok, true);
  });

  it('reconnaît le certificat par défaut de Traefik, et un certificat expiré', () => {
    assert.equal(
      parseCertificate(
        'curl subject=CN=TRAEFIK DEFAULT CERT\ncurl issuer=CN=TRAEFIK DEFAULT CERT',
        now,
      ).status,
      'pending',
    );
    assert.equal(
      parseCertificate(
        'cert subject=CN = a.fr\ncert issuer=CN = R11\ncert notAfter=Jan  1 00:00:00 2026 GMT',
        now,
      ).status,
      'invalid',
    );
    assert.equal(parseCertificate('', now).status, 'unknown');
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
