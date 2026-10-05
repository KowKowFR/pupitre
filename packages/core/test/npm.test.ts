import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  parseProxySecrets,
  proxyEntrypointHost,
  proxyPlacement,
  remoteProxyKinds,
} from '../src/proxy/catalog.js';
import { probeDirect } from '../src/proxy/direct-probe.js';
import { NPM_PROBE, npmConfigSchema, npmEntrypoint } from '../src/proxy/npm/config.js';
import {
  NginxProxyManagerProvider,
  certificateCovers,
  coveringCertificate,
  npmDate,
  plainOnPublicAddress,
} from '../src/proxy/npm/provider.js';
import type { NpmCertificate } from '../src/proxy/npm/api.js';
import { ProxyError, type ProxyRouteSet, type RemoteProxyContext } from '../src/proxy/types.js';

/**
 * Nginx Proxy Manager, without a container: its configuration, choosing a
 * certificate, the probe from the panel — and the whole provider against a fake
 * in-memory NPM, which holds its API and its visitors' entrance. The real one is
 * tested by `pnpm test:npm`.
 */

describe('NPM — the connection', () => {
  it('brings the interface’s address back to itself, and probes its machine by default', () => {
    const config = npmConfigSchema.parse({
      url: ' http://10.0.0.5:81/api/ ',
      email: 'pupitre@exemple.fr',
    });
    assert.equal(config.url, 'http://10.0.0.5:81');
    assert.deepEqual(npmEntrypoint(config), { host: '10.0.0.5', httpPort: 80, httpsPort: 443 });
    assert.equal(proxyEntrypointHost('npm', config), '10.0.0.5');
    assert.throws(() => npmConfigSchema.parse({ url: 'ftp://npm', email: 'a@b.fr' }));
  });

  it('is a remote proxy, with a password as secret', () => {
    assert.equal(proxyPlacement('npm'), 'remote');
    assert.equal(proxyPlacement('traefik'), 'target');
    assert.deepEqual(remoteProxyKinds(), ['npm']);
    assert.deepEqual(parseProxySecrets('npm', { password: 's3cret' }), { password: 's3cret' });
    assert.throws(() => parseProxySecrets('npm', { password: '' }));
    // A proxy on a target has no secrets to store.
    assert.throws(() => parseProxySecrets('traefik', { token: 'x' }));
  });

  it('refuses a clear-text password toward a public IP address', () => {
    assert.equal(plainOnPublicAddress('http://203.0.113.10:81'), true);
    assert.equal(plainOnPublicAddress('http://[2001:db8::1]:81'), true);
    assert.equal(plainOnPublicAddress('http://10.0.0.5:81'), false);
    assert.equal(plainOnPublicAddress('https://203.0.113.10'), false);
    // A name cannot be judged without resolving it — even one made of letters a to
    // f.
    assert.equal(plainOnPublicAddress('http://face.de:81'), false);
  });

  it('reads its dates as UTC', () => {
    assert.equal(
      new Date(npmDate('2026-12-31 07:54:28')).toISOString(),
      '2026-12-31T07:54:28.000Z',
    );
  });
});

describe('NPM — the certificate to reuse', () => {
  const certificate = (id: number, names: string[], expires: string | null): NpmCertificate => ({
    id,
    provider: 'other',
    nice_name: names.join(', '),
    domain_names: names,
    expires_on: expires,
  });
  const now = Date.parse('2026-10-02T00:00:00Z');

  it('covers an exact name, or a one-level wildcard only', () => {
    const joker = certificate(1, ['*.exemple.fr'], '2027-01-01 00:00:00');
    assert.equal(certificateCovers(joker, 'app.exemple.fr'), true);
    assert.equal(certificateCovers(joker, 'a.b.exemple.fr'), false);
    assert.equal(certificateCovers(joker, 'exemple.fr'), false);
    assert.equal(
      certificateCovers(certificate(2, ['App.Exemple.fr'], null), 'app.exemple.fr'),
      true,
    );
  });

  it('takes the furthest-expiring, never an expired one', () => {
    const chosen = coveringCertificate(
      [
        certificate(1, ['*.exemple.fr'], '2026-09-01 00:00:00'),
        certificate(2, ['app.exemple.fr'], '2026-12-01 00:00:00'),
        certificate(3, ['*.exemple.fr'], '2027-03-01 00:00:00'),
        certificate(4, ['autre.fr'], '2028-01-01 00:00:00'),
      ],
      'app.exemple.fr',
      now,
    );
    assert.equal(chosen?.id, 3);
    assert.equal(
      coveringCertificate(
        [certificate(1, ['*.exemple.fr'], '2026-09-01 00:00:00')],
        'app.exemple.fr',
        now,
      ),
      null,
    );
  });
});

// ─── a fake NPM ──────────────────────────────────────────────────────────────

type FakeHost = {
  id: number;
  created_on: string;
  owner_user_id: number;
  domain_names: string[];
  forward_scheme: string;
  forward_host: string;
  forward_port: number;
  certificate_id: number;
  ssl_forced: boolean;
  http2_support: boolean;
  enabled: boolean;
  block_exploits?: boolean;
  meta: Record<string, unknown>;
};

const PASSWORD = 'bon-mot-de-passe';

/** An NPM's API and entrance, in memory: what Pupitre uses of it, no more. */
class FakeNpm {
  hosts: FakeHost[] = [];
  certificates: NpmCertificate[] = [];
  next = 1;
  /** What happened, in order: `host+ name`, `cert+ name`, `host- name`… */
  events: string[] = [];
  certbotBusy = false;
  overlapping = false;
  /** The number of default-site answers before a new host is served. */
  reloadLag = 0;
  permissions: Record<string, string> = {
    visibility: 'user',
    proxy_hosts: 'manage',
    certificates: 'manage',
  };
  private lag = new Map<string, number>();
  api!: http.Server;
  entry!: http.Server;

  async start(): Promise<void> {
    this.api = http.createServer((request, response) => void this.handleApi(request, response));
    this.entry = http.createServer((request, response) => this.handleEntry(request, response));
    await Promise.all([
      new Promise<void>((resolve) => this.api.listen(0, '127.0.0.1', resolve)),
      new Promise<void>((resolve) => this.entry.listen(0, '127.0.0.1', resolve)),
    ]);
  }

  async stop(): Promise<void> {
    await Promise.all([
      new Promise((resolve) => this.api.close(resolve)),
      new Promise((resolve) => this.entry.close(resolve)),
    ]);
  }

  get url(): string {
    return `http://127.0.0.1:${(this.api.address() as AddressInfo).port}`;
  }

  get entrypoint() {
    return {
      host: '127.0.0.1',
      httpPort: (this.entry.address() as AddressInfo).port,
      httpsPort: 1,
    };
  }

  private send(response: http.ServerResponse, status: number, body: unknown) {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  }

  private async handleApi(request: http.IncomingMessage, response: http.ServerResponse) {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    const route = `${request.method} ${request.url}`;
    const id = Number(/\/(\d+)$/.exec(request.url ?? '')?.[1]);

    if (route === 'GET /api/')
      return this.send(response, 200, {
        status: 'OK',
        version: { major: 2, minor: 16, revision: 0 },
      });
    if (route === 'POST /api/tokens') {
      return body.secret === PASSWORD
        ? this.send(response, 200, { token: 'jeton' })
        : this.send(response, 401, { error: { code: 401, message: 'Invalid email or password' } });
    }
    if (request.headers.authorization !== 'Bearer jeton') {
      return this.send(response, 401, { error: { code: 401, message: 'Permission Denied' } });
    }
    if (route === 'GET /api/users/me?expand=permissions') {
      return this.send(response, 200, {
        id: 2,
        email: 'pupitre@exemple.fr',
        roles: [],
        permissions: this.permissions,
      });
    }
    if (route === 'GET /api/nginx/proxy-hosts') return this.send(response, 200, this.hosts);
    if (route === 'POST /api/nginx/proxy-hosts') {
      const taken = this.hosts.some((host) => host.domain_names.includes(body.domain_names[0]));
      if (taken) {
        return this.send(response, 400, {
          error: { code: 400, message: `${body.domain_names[0]} is already in use` },
        });
      }
      const host: FakeHost = {
        id: this.next++,
        created_on: '2026-10-02 08:00:00',
        owner_user_id: 2,
        ...body,
        meta: { ...body.meta, nginx_online: true },
      };
      this.hosts.push(host);
      this.lag.set(host.domain_names[0]!, this.reloadLag);
      this.events.push(`host+ ${host.domain_names[0]}`);
      return this.send(response, 201, host);
    }
    if (request.method === 'PUT' && request.url?.startsWith('/api/nginx/proxy-hosts/')) {
      const host = this.hosts.find((candidate) => candidate.id === id)!;
      Object.assign(host, body, { meta: { ...body.meta, nginx_online: true } });
      this.events.push(`host~ ${host.domain_names[0]}`);
      return this.send(response, 200, host);
    }
    if (request.method === 'DELETE' && request.url?.startsWith('/api/nginx/proxy-hosts/')) {
      const host = this.hosts.find((candidate) => candidate.id === id);
      this.hosts = this.hosts.filter((candidate) => candidate.id !== id);
      this.events.push(`host- ${host?.domain_names[0]}`);
      return this.send(response, 200, true);
    }
    if (route === 'GET /api/nginx/certificates') return this.send(response, 200, this.certificates);
    if (route === 'POST /api/nginx/certificates') {
      // Like the real one: a single certbot at a time, the second refused right away.
      if (this.certbotBusy) {
        this.overlapping = true;
        return this.send(response, 500, { error: { code: 500, message: 'Internal Error' } });
      }
      this.certbotBusy = true;
      await new Promise((resolve) => setTimeout(resolve, 30));
      this.certbotBusy = false;
      const name = body.domain_names[0] as string;
      if (name.startsWith('sans-dns.')) {
        await new Promise((resolve) => setTimeout(resolve, 1600));
        return this.send(response, 500, { error: { code: 500, message: 'Internal Error' } });
      }
      const certificate = {
        id: this.next++,
        provider: 'letsencrypt',
        nice_name: name,
        domain_names: [name],
        expires_on: '2099-01-01 00:00:00',
      };
      this.certificates.push(certificate);
      this.events.push(`cert+ ${name}`);
      return this.send(response, 201, certificate);
    }
    if (request.method === 'DELETE' && request.url?.startsWith('/api/nginx/certificates/')) {
      this.certificates = this.certificates.filter((certificate) => certificate.id !== id);
      this.events.push(`cert- ${id}`);
      return this.send(response, 200, true);
    }
    this.send(response, 404, { error: { code: 404, message: `Not Found - ${request.url}` } });
  }

  /** The visitors' entrance: the default site, or the host's upstream — here, an echo. */
  private handleEntry(request: http.IncomingMessage, response: http.ServerResponse) {
    const name = request.headers.host ?? '';
    const host = this.hosts.find((candidate) => candidate.domain_names.includes(name));
    const lag = this.lag.get(name) ?? 0;
    if (!host || lag > 0) {
      this.lag.set(name, lag - 1);
      if (request.url === '/') {
        response.writeHead(200);
        response.end(`<p>You've ${NPM_PROBE.noRouteBody}.</p>`);
      } else {
        response.writeHead(404);
        response.end('<html><center>openresty</center></html>');
      }
      return;
    }
    // Port 1 "refuses", port 2 "does not answer"; elsewhere, the path comes back.
    if (host.forward_port === 1) {
      response.writeHead(502);
      response.end('Bad Gateway');
      return;
    }
    if (host.forward_port === 2) {
      response.writeHead(504);
      response.end('Gateway Timeout');
      return;
    }
    response.writeHead(200);
    response.end(`${request.url?.slice(1)}\n`);
  }
}

describe('NPM — the provider, against a fake NPM', () => {
  const npm = new FakeNpm();
  const provider = new NginxProxyManagerProvider();
  let ctx: RemoteProxyContext;
  const set = (
    routes: string[],
    options: { app?: string; scope?: string; port?: number } = {},
  ): ProxyRouteSet => ({
    appSlug: options.app ?? 'vitrine',
    ...(options.scope ? { scope: options.scope } : {}),
    routes: routes.map((hostname) => ({
      hostname,
      tls: !hostname.startsWith('http.'),
      redirectHttps: true,
      waf: 'block' as const,
    })),
    upstream: { kind: 'port', port: options.port ?? 30100, host: '10.0.0.12' },
  });
  const noLog = () => {};

  before(async () => {
    await npm.start();
    ctx = {
      config: { url: npm.url, email: 'pupitre@exemple.fr', entrypoint: npm.entrypoint },
      secrets: { password: PASSWORD },
      language: 'fr',
    };
  });
  after(async () => npm.stop());
  beforeEach(() => {
    npm.hosts = [];
    npm.certificates = [];
    npm.events = [];
    npm.overlapping = false;
    npm.reloadLag = 0;
  });

  it('“Test”: a wrong password, insufficient rights — said as such', async () => {
    const good = await provider.check(ctx, noLog);
    assert.equal(good.checks.find((item) => item.key === 'rights')?.ok, true);
    assert.equal(good.checks.find((item) => item.key === 'api')?.detail?.includes('2.16.0'), true);

    const refused = await provider.check({ ...ctx, secrets: { password: 'faux' } }, noLog);
    assert.equal(refused.ok, false);
    assert.match(
      refused.checks.find((item) => item.key === 'login')?.detail ?? '',
      /identifiants refusés/,
    );

    npm.permissions = { visibility: 'all', proxy_hosts: 'view', certificates: 'manage' };
    const short = await provider.check(ctx, noLog);
    assert.equal(short.checks.find((item) => item.key === 'rights')?.ok, false);
    npm.permissions = { visibility: 'user', proxy_hosts: 'manage', certificates: 'manage' };
  });

  it('sets one host per domain, marked, the certificate requested before the host', async () => {
    await provider.apply(ctx, set(['app.exemple.fr', 'http.exemple.fr']), noLog);
    assert.deepEqual(npm.events, [
      'cert+ app.exemple.fr',
      'host+ app.exemple.fr',
      'host+ http.exemple.fr',
    ]);
    const app = npm.hosts.find((host) => host.domain_names[0] === 'app.exemple.fr')!;
    assert.equal(app.forward_host, '10.0.0.12');
    assert.equal(app.ssl_forced, true);
    assert.ok(app.certificate_id > 0);
    assert.deepEqual(app.meta.pupitre, {
      app: 'vitrine',
      scope: null,
      certificate: app.certificate_id,
    });
    const plain = npm.hosts.find((host) => host.domain_names[0] === 'http.exemple.fr')!;
    assert.equal(plain.certificate_id, 0);
    assert.equal(plain.ssl_forced, false);
  });

  it('changes nothing when nothing changes, and only holds its own fields', async () => {
    await provider.apply(ctx, set(['app.exemple.fr']), noLog);
    // A setting made in NPM on a Pupitre host.
    npm.hosts[0]!.block_exploits = true;
    npm.events = [];
    await provider.apply(ctx, set(['app.exemple.fr']), noLog);
    assert.deepEqual(npm.events, []);
    await provider.apply(ctx, set(['app.exemple.fr'], { port: 30101 }), noLog);
    assert.deepEqual(npm.events, ['host~ app.exemple.fr']);
    assert.equal(npm.hosts[0]!.forward_port, 30101);
    assert.equal(npm.hosts[0]!.block_exploits, true);
  });

  it('removes what it set up, its certificate with it — never what is not its own', async () => {
    npm.hosts.push({
      id: 900,
      created_on: '2026-10-01 00:00:00',
      owner_user_id: 1,
      domain_names: ['main.exemple.fr'],
      forward_scheme: 'http',
      forward_host: '10.0.0.99',
      forward_port: 8080,
      certificate_id: 0,
      ssl_forced: false,
      http2_support: false,
      enabled: true,
      meta: {},
    });
    await provider.apply(ctx, set(['app.exemple.fr']), noLog);
    await provider.apply(ctx, set(['autre.exemple.fr'], { app: 'autre' }), noLog);
    const ownCertificate = npm.certificates.find((c) => c.domain_names[0] === 'app.exemple.fr')!.id;
    npm.events = [];
    await provider.apply(ctx, set([]), noLog);
    assert.deepEqual(npm.events, ['host- app.exemple.fr', `cert- ${ownCertificate}`]);
    assert.deepEqual(npm.hosts.map((host) => host.domain_names[0]).sort(), [
      'autre.exemple.fr',
      'main.exemple.fr',
    ]);
  });

  it('a machine does not touch another’s domains (scope)', async () => {
    await provider.apply(ctx, set(['un.exemple.fr'], { scope: 'tAAAA' }), noLog);
    await provider.apply(ctx, set(['deux.exemple.fr'], { scope: 'tBBBB' }), noLog);
    await provider.apply(ctx, set([], { scope: 'tAAAA' }), noLog);
    assert.deepEqual(
      npm.hosts.map((host) => host.domain_names[0]),
      ['deux.exemple.fr'],
    );
  });

  it('reuses a wildcard already in NPM, and does not remove it', async () => {
    npm.certificates.push({
      id: 500,
      provider: 'other',
      nice_name: 'joker',
      domain_names: ['*.joker.fr'],
      expires_on: '2099-01-01 00:00:00',
    });
    await provider.apply(ctx, set(['app.joker.fr']), noLog);
    assert.equal(npm.hosts[0]!.certificate_id, 500);
    assert.ok(!npm.events.some((event) => event.startsWith('cert+')));
    await provider.apply(ctx, set([]), noLog);
    assert.ok(npm.certificates.some((certificate) => certificate.id === 500));
  });

  it('refuses a domain another already carries, saying so, and sets the others', async () => {
    npm.hosts.push({
      id: 901,
      created_on: '2026-10-01 00:00:00',
      owner_user_id: 1,
      domain_names: ['pris.exemple.fr'],
      forward_scheme: 'http',
      forward_host: '10.0.0.99',
      forward_port: 8080,
      certificate_id: 0,
      ssl_forced: false,
      http2_support: false,
      enabled: true,
      meta: {},
    });
    await assert.rejects(
      provider.apply(ctx, set(['http.pris.exemple.fr', 'pris.exemple.fr']), noLog),
      (error: unknown) => error instanceof ProxyError && /existe déjà dans NPM/.test(error.message),
    );
    assert.ok(npm.hosts.some((host) => host.domain_names[0] === 'http.pris.exemple.fr'));
  });

  it('puts certificate requests one after the other', async () => {
    await Promise.all([
      provider.apply(ctx, set(['un.exemple.fr'], { app: 'un' }), noLog),
      provider.apply(ctx, set(['deux.exemple.fr'], { app: 'deux' }), noLog),
      provider.apply(ctx, set(['trois.exemple.fr'], { app: 'trois' }), noLog),
    ]);
    assert.equal(npm.overlapping, false);
    assert.equal(npm.certificates.length, 3);
  });

  it('without an obtained certificate, the domain is served over HTTP, and the probe says why', async () => {
    const lines: string[] = [];
    await provider.apply(ctx, set(['sans-dns.exemple.fr']), (line) => lines.push(line));
    assert.equal(npm.hosts[0]!.certificate_id, 0);
    assert.ok(lines.some((line) => line.includes('n’a pas obtenu de certificat')));
    const probe = await provider.probe(
      ctx,
      { hostname: 'sans-dns.exemple.fr', tls: true, redirectHttps: true, waf: 'block' },
      '/',
    );
    assert.equal(probe.ok, false);
    assert.equal(probe.certificate.status, 'pending');
    assert.match(probe.detail, /pas encore de certificat/);
  });

  it('probe from the panel: an unknown domain is recognized', async () => {
    const unknown = await probeDirect(
      npm.entrypoint,
      { hostname: 'inconnu.exemple.fr', tls: false, redirectHttps: false, waf: 'off' },
      '/',
      NPM_PROBE,
    );
    assert.equal(unknown.ok, false);
    assert.match(unknown.detail, /ne connaît pas ce domaine/);
    await provider.apply(ctx, set(['http.exemple.fr']), noLog);
    const known = await probeDirect(
      npm.entrypoint,
      { hostname: 'http.exemple.fr', tls: false, redirectHttps: false, waf: 'off' },
      '/sante',
      NPM_PROBE,
    );
    assert.equal(known.ok, true);
    assert.equal(known.http, 200);
  });

  it('tests a path through it, waits for nginx to reload, and leaves nothing', async () => {
    npm.reloadLag = 3;
    const ok = await provider.reach(
      ctx,
      { address: '10.0.0.12', port: 30105, token: 'abc123' },
      noLog,
    );
    assert.deepEqual(ok, { curlCode: 0, body: 'abc123\n' });
    assert.deepEqual(
      await provider.reach(ctx, { address: '10.0.0.12', port: 1, token: 'x' }, noLog),
      {
        curlCode: 7,
        body: '',
      },
    );
    assert.deepEqual(
      await provider.reach(ctx, { address: '10.0.0.12', port: 2, token: 'y' }, noLog),
      {
        curlCode: 28,
        body: '',
      },
    );
    assert.equal(npm.hosts.length, 0);
  });
});
