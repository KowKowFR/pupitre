import { isIP } from 'node:net';
import type { LogSink } from '../../drivers/types.js';
import { entrypointAnswers, probeDirect, requestThrough } from '../direct-probe.js';
import { isPrivateAddress } from '../model.js';
import {
  ProxyError,
  type ProxyCheck,
  type ProxyRoute,
  type ProxyRouteSet,
  type ReachAttempt,
  type RemoteProxyContext,
  type RemoteProxyProvider,
  type RouteProbe,
} from '../types.js';
import {
  NpmApiError,
  NpmClient,
  npmHealth,
  type NpmCertificate,
  type NpmHost,
  type NpmMark,
} from './api.js';
import {
  NPM_PROBE,
  npmConfigSchema,
  npmEntrypoint,
  npmSecretsSchema,
  type NpmConfig,
} from './config.js';
import { errorMessage } from '../../error-message.js';
import { npmSay } from './messages.js';

/**
 * Nginx Proxy Manager, driven through its API — a **remote** proxy: Pupitre does
 * not drive its machine, it hands it hosts.
 *
 * ── What belongs to Pupitre ─────────────────────────────────────────────────
 * One domain = one NPM "proxy host", marked in its `meta` (`pupitre`: the
 * application, the served machine). Pupitre only reads, changes and removes
 * those; hosts set up by hand stay intact — and a domain they already carry is
 * refused by NPM, which is reported as is.
 *
 * On a Pupitre host, only the domain, the upstream and HTTPS are held: what is
 * set on it in NPM (access list, cache, protection, headers) is kept from one
 * deployment to the next.
 *
 * ── Certificates ────────────────────────────────────────────────────────────
 * A certificate already present in NPM that covers the domain — a
 * `*.example.com` wildcard obtained through a DNS challenge, typically — is
 * reused as is. Otherwise, NPM requests one from Let's Encrypt, in the account's
 * name; that one belongs to Pupitre, and leaves with the host. A refused request
 * (DNS not yet pointing to NPM, port 80 closed) leaves the domain served over
 * HTTP: the next deployment or "Apply" requests it again.
 */

const MARK = 'pupitre';
/** The domain of a link test's ephemeral hosts — never resolved. */
const REACH_DOMAIN = 'reach.pupitre.invalid';
/** A test host older than this was forgotten by an interrupted test. */
const REACH_STALE_MS = 10 * 60_000;
/** The test's relay is bounded like `checkReach()`: 5 s to connect. */
const REACH_NGINX = 'proxy_connect_timeout 5s;\nproxy_read_timeout 10s;';

/**
 * Does the response come from NPM's default site, and not from a host? Its home
 * page, or its nginx's 404 for any other path.
 */
function servedByDefaultSite(answer: { code: number; body: string }): boolean {
  return (
    answer.body.includes(NPM_PROBE.noRouteBody) ||
    (answer.code === 404 && answer.body.includes('<center>openresty</center>'))
  );
}

/** A refusal faster than this did not reach the certificate authority. */
const BUSY_FAILURE_MS = 1500;

/** The certificate requests in progress, per NPM instance. */
const certificateQueues = new Map<string, Promise<unknown>>();

/** One request at a time per instance: the next one waits for the previous one to finish. */
async function oneAtATime<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = certificateQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(run);
  const settled = current.catch(() => undefined);
  certificateQueues.set(key, settled);
  try {
    return await current;
  } finally {
    if (certificateQueues.get(key) === settled) certificateQueues.delete(key);
  }
}

/**
 * Would the account's password travel in clear over the Internet? Over HTTP to
 * a public IP address, yes. A name cannot be judged without resolving it: it
 * passes, with the advice to keep it to a private network.
 */
export function plainOnPublicAddress(value: string): boolean {
  const url = new URL(value);
  const literal = url.hostname.replace(/^\[|\]$/g, '');
  return url.protocol === 'http:' && isIP(literal) !== 0 && !isPrivateAddress(literal);
}

function markOf(host: NpmHost): NpmMark | null {
  const mark = host.meta?.[MARK];
  return mark && typeof mark === 'object' ? (mark as NpmMark) : null;
}

/** Does the certificate cover this name — exactly, or through a one-level wildcard? */
export function certificateCovers(certificate: NpmCertificate, hostname: string): boolean {
  const parent = hostname.slice(hostname.indexOf('.') + 1);
  return certificate.domain_names.some(
    (name) => name.toLowerCase() === hostname || name.toLowerCase() === `*.${parent}`,
  );
}

/** An NPM date — `2026-12-31 07:54:28`, in UTC without saying so. */
export function npmDate(value: string): number {
  return Date.parse(`${value.trim().replace(' ', 'T')}Z`);
}

function certificateUsable(certificate: NpmCertificate, now = Date.now()): boolean {
  if (!certificate.expires_on) return false;
  const expires = npmDate(certificate.expires_on);
  return Number.isNaN(expires) || expires > now;
}

/** The certificate to reuse for this name: the furthest-expiring one that covers it. */
export function coveringCertificate(
  certificates: NpmCertificate[],
  hostname: string,
  now = Date.now(),
): NpmCertificate | null {
  return (
    certificates
      .filter((certificate) => certificateCovers(certificate, hostname))
      .filter((certificate) => certificateUsable(certificate, now))
      .sort((a, b) => (b.expires_on ?? '').localeCompare(a.expires_on ?? ''))[0] ?? null
  );
}

export class NginxProxyManagerProvider implements RemoteProxyProvider {
  readonly kind = 'npm' as const;

  parseConfig(config: unknown): NpmConfig {
    return npmConfigSchema.parse(config);
  }

  private async open(ctx: RemoteProxyContext): Promise<{ config: NpmConfig; client: NpmClient }> {
    const config = this.parseConfig(ctx.config);
    const { password } = npmSecretsSchema.parse(ctx.secrets);
    return {
      config,
      client: await NpmClient.login(config.url, config.email, password, ctx.language),
    };
  }

  // ─── tester ─────────────────────────────────────────────────────────────────

  async check(ctx: RemoteProxyContext, onLog: LogSink): Promise<ProxyCheck> {
    const say = npmSay(ctx.language);
    const config = this.parseConfig(ctx.config);
    const checks: ProxyCheck['checks'] = [];
    const done = (): ProxyCheck => ({ ok: checks.every((item) => item.ok), checks });

    try {
      const health = await npmHealth(config.url, ctx.language);
      const version = health.version
        ? `${health.version.major}.${health.version.minor}.${health.version.revision}`
        : null;
      checks.push({
        key: 'api',
        label: 'API',
        ok: health.status === 'OK',
        detail: say('check.api.detail', { version: version ? ` ${version}` : '', url: config.url }),
      });
    } catch (error) {
      checks.push({ key: 'api', label: 'API', ok: false, detail: errorMessage(error) });
      return done();
    }

    const url = new URL(config.url);
    const publicPlain = plainOnPublicAddress(config.url);
    checks.push({
      key: 'transport',
      label: say('check.transport'),
      ok: !publicPlain,
      detail:
        url.protocol === 'https:'
          ? 'HTTPS'
          : publicPlain
            ? say('check.transport.publicPlain')
            : say('check.transport.privatePlain'),
    });

    let client: NpmClient;
    try {
      client = (await this.open(ctx)).client;
      checks.push({ key: 'login', label: say('check.login'), ok: true, detail: config.email });
    } catch (error) {
      checks.push({
        key: 'login',
        label: say('check.login'),
        ok: false,
        detail: errorMessage(error),
      });
      return done();
    }

    try {
      const me = await client.me();
      const admin = me.roles.includes('admin');
      const rights = me.permissions;
      const allowed =
        admin || (rights?.proxy_hosts === 'manage' && rights.certificates === 'manage');
      checks.push({
        key: 'rights',
        label: say('check.rights'),
        ok: allowed,
        detail: allowed
          ? admin
            ? say('check.rights.admin')
            : rights?.visibility === 'user'
              ? say('check.rights.own')
              : say('check.rights.manage')
          : say('check.rights.missing'),
      });
    } catch (error) {
      checks.push({
        key: 'rights',
        label: say('check.rights'),
        ok: false,
        detail: errorMessage(error),
      });
    }

    // Domain probes go from the panel to NPM's entrance.
    const entrypoint = npmEntrypoint(config);
    const answers = await entrypointAnswers(entrypoint);
    checks.push({
      key: 'entrypoint',
      label: say('check.entrypoint'),
      ok: answers.http > 0,
      detail:
        answers.http > 0
          ? say(answers.httpsOpen ? 'check.entrypoint.both' : 'check.entrypoint.httpOnly', {
              host: entrypoint.host,
              http: entrypoint.httpPort,
              https: entrypoint.httpsPort,
            })
          : say('check.entrypoint.down', { host: entrypoint.host, port: entrypoint.httpPort }),
    });
    onLog(
      say('check.summary', {
        url: config.url,
        checks: checks.map((item) => `${item.label} ${item.ok ? 'ok' : '✗'}`).join(', '),
      }),
    );
    return done();
  }

  // ─── applying routes ────────────────────────────────────────────────────────

  async apply(ctx: RemoteProxyContext, set: ProxyRouteSet, onLog: LogSink): Promise<void> {
    const say = npmSay(ctx.language);
    const { client } = await this.open(ctx);
    const scope = set.scope ?? null;
    const hosts = await client.hosts();
    const mine = hosts.filter((host) => {
      const mark = markOf(host);
      return mark?.app === set.appSlug && (mark.scope ?? null) === scope && !mark.reach;
    });

    let upstream: { host: string; port: number } | null = null;
    if (set.routes.length > 0) {
      if (set.upstream?.kind !== 'port' || !set.upstream.host) {
        throw new ProxyError(say('apply.needsAddress'), this.kind, 'apply');
      }
      upstream = { host: set.upstream.host, port: set.upstream.port };
    }

    // NPM's certificates, read once — to reuse those that already cover a domain.
    let certificates: NpmCertificate[] | null = null;
    const listCertificates = async () => (certificates ??= await client.certificates());
    // Certificates that left a Pupitre host: to remove if it had requested them.
    const released = new Set<number>();
    const problems: string[] = [];

    const wanted = new Set(set.routes.map((route) => route.hostname));
    for (const host of mine) {
      if (host.domain_names.length === 1 && wanted.has(host.domain_names[0]!)) continue;
      await client.deleteHost(host.id);
      onLog(say('apply.hostRemoved', { hostnames: host.domain_names.join(', ') }));
      const owned = markOf(host)?.certificate;
      if (owned) released.add(owned);
    }

    for (const route of set.routes) {
      try {
        const existing = mine.find(
          (host) => host.domain_names.length === 1 && host.domain_names[0] === route.hostname,
        );
        const result = await this.ensureHost(
          client,
          route,
          upstream!,
          existing ?? null,
          { app: set.appSlug, scope },
          listCertificates,
          onLog,
        );
        if (result.released) released.add(result.released);
      } catch (error) {
        problems.push(
          error instanceof NpmApiError && /already in use/i.test(error.message)
            ? say('apply.foreign', { hostname: route.hostname })
            : `${route.hostname} : ${errorMessage(error)}`,
        );
      }
    }

    // A certificate requested by Pupitre that no host uses anymore goes.
    if (released.size > 0) {
      const still = new Set((await client.hosts()).map((host) => host.certificate_id));
      for (const id of released) {
        if (still.has(id)) continue;
        await client
          .deleteCertificate(id)
          .then(() => onLog(say('apply.certificateRemoved', { id })))
          .catch((error: unknown) =>
            onLog(say('apply.certificateKept', { id, error: errorMessage(error) })),
          );
      }
    }
    if (problems.length > 0) throw new ProxyError(problems.join(' · '), this.kind, 'apply');
  }

  /**
   * A domain, set up: the host (created or updated), then its certificate.
   * Returns the Pupitre certificate the host just left, if there is one.
   */
  private async ensureHost(
    client: NpmClient,
    route: ProxyRoute,
    upstream: { host: string; port: number },
    existing: NpmHost | null,
    owner: { app: string; scope: string | null },
    listCertificates: () => Promise<NpmCertificate[]>,
    onLog: LogSink,
  ): Promise<{ released: number | null }> {
    const say = npmSay(client.language);
    const previousMark = existing ? markOf(existing) : null;
    let certificateId = 0;
    let owned: number | null = null;

    if (route.tls) {
      const certificates = await listCertificates();
      const current = existing?.certificate_id
        ? certificates.find((certificate) => certificate.id === existing.certificate_id)
        : undefined;
      const reusable =
        current && certificateCovers(current, route.hostname) && certificateUsable(current)
          ? current
          : coveringCertificate(certificates, route.hostname);
      if (reusable) {
        certificateId = reusable.id;
        owned = previousMark?.certificate === reusable.id ? reusable.id : null;
        if (reusable.id !== existing?.certificate_id) {
          onLog(say('apply.reuses', { hostname: route.hostname, name: reusable.nice_name }));
        }
      }
    }

    // A new host without a certificate covering it: we request it **before**
    // creating the host. As long as no host carries this name, it is NPM's default
    // site that answers the HTTP-01 challenge, and it always serves it; for a host
    // already there, NPM must remove it from nginx during the request, and does not
    // give nginx time to reload (see `requestCertificate`).
    if (route.tls && certificateId === 0 && !existing) {
      const obtained = await this.requestCertificate(client, route.hostname, 1, onLog);
      if (obtained) {
        certificateId = obtained;
        owned = obtained;
      }
    }

    const fields = (certificate: number, ownedId: number | null) => ({
      domain_names: [route.hostname],
      forward_scheme: 'http',
      forward_host: upstream.host,
      forward_port: upstream.port,
      certificate_id: certificate,
      ssl_forced: certificate > 0 && route.redirectHttps,
      http2_support: certificate > 0,
      meta: { [MARK]: { ...owner, certificate: ownedId } satisfies NpmMark },
    });

    if (!existing) {
      await client.createHost({
        ...fields(certificateId, owned),
        // The settings Pupitre does not hold: those of a new host in NPM, plus
        // WebSocket relaying. They can be changed in NPM afterwards.
        hsts_enabled: false,
        hsts_subdomains: false,
        block_exploits: false,
        caching_enabled: false,
        allow_websocket_upgrade: true,
        access_list_id: 0,
        advanced_config: '',
        enabled: true,
        locations: [],
      });
      onLog(
        say('apply.host', {
          hostname: route.hostname,
          upstream: `${upstream.host}:${upstream.port}`,
        }),
      );
    } else {
      const wanted = fields(certificateId, owned);
      const changed =
        existing.forward_host !== wanted.forward_host ||
        existing.forward_port !== wanted.forward_port ||
        existing.forward_scheme !== wanted.forward_scheme ||
        existing.certificate_id !== wanted.certificate_id ||
        existing.ssl_forced !== wanted.ssl_forced ||
        !existing.enabled ||
        JSON.stringify(previousMark) !== JSON.stringify(wanted.meta[MARK]);
      if (changed) {
        await client.updateHost(existing.id, { ...wanted, enabled: true });
        onLog(
          say('apply.hostUpdated', {
            hostname: route.hostname,
            upstream: `${upstream.host}:${upstream.port}`,
          }),
        );
      }

      // A host already there, still without a certificate: we request it again.
      if (route.tls && certificateId === 0) {
        const obtained = await this.requestCertificate(client, route.hostname, 2, onLog);
        if (obtained) {
          certificateId = obtained;
          owned = obtained;
          await client.updateHost(existing.id, fields(certificateId, owned));
        }
      }
    }
    const left = previousMark?.certificate ?? null;
    return { released: left !== null && left !== certificateId ? left : null };
  }

  /**
   * A Let's Encrypt certificate, requested by NPM. `attempts`: 2 for a host
   * already in service — NPM removes it from nginx, reloads, and runs certbot
   * without waiting for the reload to take; if the old nginx still answers the
   * challenge, it relays it to the application. A single retry, five seconds
   * later: each failure counts toward Let's Encrypt's limit (five failed
   * validations per hour and per name). `null`: no certificate.
   */
  private async requestCertificate(
    client: NpmClient,
    hostname: string,
    attempts: number,
    onLog: LogSink,
  ): Promise<number | null> {
    const say = npmSay(client.language);
    onLog(say('certificate.requesting', { hostname }));
    // NPM only runs one certbot at a time and immediately refuses a second: this
    // worker's requests to one instance go one after the other.
    return oneAtATime(client.base, async () => {
      let failure = '';
      let busy = 0;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if (attempt > 1 || busy > 0) await new Promise((resolve) => setTimeout(resolve, 5000));
        const started = Date.now();
        try {
          const certificate = await client.requestCertificate(hostname);
          onLog(say('certificate.obtained', { hostname }));
          return certificate.id;
        } catch (error) {
          failure = errorMessage(error);
          // Refused before even querying the authority — another certbot was running,
          // started from NPM's interface: the attempt does not count.
          if (Date.now() - started < BUSY_FAILURE_MS && busy < 3) {
            busy += 1;
            attempt -= 1;
          }
        }
      }
      onLog(say('certificate.failed', { hostname, failure }));
      return null;
    });
  }

  // ─── sonder ─────────────────────────────────────────────────────────────────

  async probe(ctx: RemoteProxyContext, route: ProxyRoute, path: string): Promise<RouteProbe> {
    const config = this.parseConfig(ctx.config);
    const probe = await probeDirect(npmEntrypoint(config), route, path, NPM_PROBE, ctx.language);
    if (probe.ok || !route.tls || (probe.https ?? 0) !== 0) return probe;
    // HTTPS does not answer: NPM refuses the handshake of a name without a
    // certificate. We ask it whether that is the case, to say so.
    try {
      const { client } = await this.open(ctx);
      const host = (await client.hosts()).find(
        (candidate) => markOf(candidate) && candidate.domain_names.includes(route.hostname),
      );
      if (host && host.certificate_id === 0) {
        return {
          ...probe,
          detail: npmSay(ctx.language)('probe.noCertificate'),
          certificate: { status: 'pending', subject: null, issuer: null, notAfter: null },
        };
      }
    } catch {
      // The probe already said the essential.
    }
    return probe;
  }

  // ─── testing a link ─────────────────────────────────────────────────────────

  async reach(
    ctx: RemoteProxyContext,
    request: { address: string; port: number; token: string },
    onLog: LogSink,
  ): Promise<ReachAttempt> {
    const { config, client } = await this.open(ctx);
    const hostname = `${request.token}.${REACH_DOMAIN}`;

    // Test hosts forgotten by an interrupted test.
    for (const stale of await client.hosts()) {
      if (markOf(stale)?.reach && Date.now() - npmDate(stale.created_on) > REACH_STALE_MS) {
        await client.deleteHost(stale.id).catch(() => undefined);
      }
    }

    const host = await client.createHost({
      domain_names: [hostname],
      forward_scheme: 'http',
      forward_host: request.address,
      forward_port: request.port,
      certificate_id: 0,
      ssl_forced: false,
      block_exploits: false,
      caching_enabled: false,
      allow_websocket_upgrade: false,
      access_list_id: 0,
      advanced_config: REACH_NGINX,
      enabled: true,
      locations: [],
      meta: { [MARK]: { reach: true } satisfies NpmMark },
    });
    try {
      onLog(
        npmSay(ctx.language)('reach.relaying', {
          hostname,
          address: request.address,
          port: request.port,
        }),
      );
      const entrypoint = npmEntrypoint(config);
      // NPM reloads nginx without waiting for it to take: as long as its default site
      // answers for this name — its page, or its 404 for another path —, the test
      // host is not in service yet. Nothing has reached the listener then: we can ask
      // again.
      let answer = await requestThrough(entrypoint, hostname, `/${request.token}`);
      for (let wait = 0; wait < 20 && servedByDefaultSite(answer); wait += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        answer = await requestThrough(entrypoint, hostname, `/${request.token}`);
      }
      if (answer.code === 0) {
        throw new ProxyError(
          npmSay(ctx.language)('reach.silent', {
            host: entrypoint.host,
            port: entrypoint.httpPort,
          }),
          this.kind,
          'reach',
        );
      }
      // nginx: 502, the connection was refused or cut; 504, nothing in time.
      if (answer.code === 502) return { curlCode: 7, body: '' };
      if (answer.code === 504) return { curlCode: 28, body: '' };
      return { curlCode: 0, body: answer.body };
    } finally {
      await client.deleteHost(host.id).catch(() => undefined);
    }
  }
}
