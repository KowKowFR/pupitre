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

/**
 * Nginx Proxy Manager, piloté par son API — un proxy **distant** : Pupitre ne
 * pilote pas sa machine, il lui confie des hôtes.
 *
 * ── Ce qui est à Pupitre ────────────────────────────────────────────────────
 * Un domaine = un « proxy host » de NPM, marqué dans son `meta` (`pupitre` :
 * l'application, la machine servie). Pupitre ne lit, ne modifie et ne retire
 * que ceux-là ; les hôtes posés à la main restent intacts — et un domaine
 * qu'ils portent déjà est refusé par NPM, ce qui est dit tel quel.
 *
 * Sur un hôte de Pupitre, seuls le domaine, l'amont et le HTTPS sont tenus :
 * ce qu'on y règle dans NPM (liste d'accès, cache, protection, en-têtes) est
 * conservé d'un déploiement à l'autre.
 *
 * ── Les certificats ─────────────────────────────────────────────────────────
 * Un certificat déjà présent dans NPM qui couvre le domaine — un joker
 * `*.exemple.fr` obtenu par défi DNS, typiquement — est repris tel quel. Sinon,
 * NPM en demande un à Let's Encrypt, au nom du compte ; celui-là est à
 * Pupitre, et part avec l'hôte. Une demande refusée (DNS qui ne pointe pas
 * encore vers NPM, port 80 fermé) laisse le domaine servi en HTTP : le
 * prochain déploiement ou « Appliquer » la refait.
 */

const MARK = 'pupitre';
/** Le domaine des hôtes éphémères du test d'une liaison — jamais résolu. */
const REACH_DOMAIN = 'reach.pupitre.invalid';
/** Un hôte de test plus vieux que cela a été oublié par un test interrompu. */
const REACH_STALE_MS = 10 * 60_000;
/** Le relais du test se borne comme `checkReach()` : 5 s pour se connecter. */
const REACH_NGINX = 'proxy_connect_timeout 5s;\nproxy_read_timeout 10s;';

/**
 * La réponse vient-elle du site par défaut de NPM, et non d'un hôte ? Sa page
 * d'accueil, ou le 404 de son nginx pour tout autre chemin.
 */
function servedByDefaultSite(answer: { code: number; body: string }): boolean {
  return (
    answer.body.includes(NPM_PROBE.noRouteBody) ||
    (answer.code === 404 && answer.body.includes('<center>openresty</center>'))
  );
}

/** Un refus plus rapide que cela n'a pas atteint l'autorité de certification. */
const BUSY_FAILURE_MS = 1500;

/** Les demandes de certificat en cours, par instance de NPM. */
const certificateQueues = new Map<string, Promise<unknown>>();

/** Une demande à la fois par instance : la suivante attend la fin de la précédente. */
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
 * Le mot de passe du compte passerait-il en clair sur Internet ? En HTTP vers
 * une adresse IP publique, oui. Un nom ne se juge pas sans le résoudre : il
 * passe, avec le conseil de le réserver à un réseau privé.
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

/** Le certificat couvre-t-il ce nom — exactement, ou par un joker d'un niveau ? */
export function certificateCovers(certificate: NpmCertificate, hostname: string): boolean {
  const parent = hostname.slice(hostname.indexOf('.') + 1);
  return certificate.domain_names.some(
    (name) => name.toLowerCase() === hostname || name.toLowerCase() === `*.${parent}`,
  );
}

/** Une date de NPM — `2026-12-31 07:54:28`, en UTC sans le dire. */
export function npmDate(value: string): number {
  return Date.parse(`${value.trim().replace(' ', 'T')}Z`);
}

function certificateUsable(certificate: NpmCertificate, now = Date.now()): boolean {
  if (!certificate.expires_on) return false;
  const expires = npmDate(certificate.expires_on);
  return Number.isNaN(expires) || expires > now;
}

/** Le certificat à reprendre pour ce nom : le plus lointain qui le couvre. */
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
    return { config, client: await NpmClient.login(config.url, config.email, password) };
  }

  // ─── tester ─────────────────────────────────────────────────────────────────

  async check(ctx: RemoteProxyContext, onLog: LogSink): Promise<ProxyCheck> {
    const config = this.parseConfig(ctx.config);
    const checks: ProxyCheck['checks'] = [];
    const done = (): ProxyCheck => ({ ok: checks.every((item) => item.ok), checks });

    try {
      const health = await npmHealth(config.url);
      const version = health.version
        ? `${health.version.major}.${health.version.minor}.${health.version.revision}`
        : null;
      checks.push({
        key: 'api',
        label: 'API',
        ok: health.status === 'OK',
        detail: `Nginx Proxy Manager${version ? ` ${version}` : ''} à ${config.url}`,
      });
    } catch (error) {
      checks.push({ key: 'api', label: 'API', ok: false, detail: errorMessage(error) });
      return done();
    }

    const url = new URL(config.url);
    const publicPlain = plainOnPublicAddress(config.url);
    checks.push({
      key: 'transport',
      label: 'Chiffrement',
      ok: !publicPlain,
      detail:
        url.protocol === 'https:'
          ? 'HTTPS'
          : publicPlain
            ? `HTTP sur une adresse publique : le mot de passe du compte passerait en clair — passez par HTTPS, ou par une adresse privée`
            : 'HTTP, à réserver à un réseau privé',
    });

    let client: NpmClient;
    try {
      client = (await this.open(ctx)).client;
      checks.push({ key: 'login', label: 'Compte', ok: true, detail: config.email });
    } catch (error) {
      checks.push({ key: 'login', label: 'Compte', ok: false, detail: errorMessage(error) });
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
        label: 'Droits',
        ok: allowed,
        detail: allowed
          ? admin
            ? 'administrateur de NPM'
            : `gère les hôtes et les certificats${rights?.visibility === 'user' ? ' — les siens seulement' : ''}`
          : 'le compte doit pouvoir gérer (« Manage ») les Proxy Hosts et les SSL Certificates',
      });
    } catch (error) {
      checks.push({ key: 'rights', label: 'Droits', ok: false, detail: errorMessage(error) });
    }

    // Les sondes des domaines partent du panel vers l'entrée de NPM.
    const entrypoint = npmEntrypoint(config);
    const answers = await entrypointAnswers(entrypoint);
    checks.push({
      key: 'entrypoint',
      label: 'Entrée',
      ok: answers.http > 0,
      detail:
        answers.http > 0
          ? `reçoit sur ${entrypoint.host}:${entrypoint.httpPort}${answers.httpsOpen ? ` et ${entrypoint.httpsPort}` : ` — ${entrypoint.httpsPort} fermé`}`
          : `${entrypoint.host}:${entrypoint.httpPort} ne répond pas depuis le panel : les domaines ne pourront pas être sondés — réglez l'adresse où NPM reçoit les visiteurs`,
    });
    onLog(
      `NPM ${config.url} : ${checks.map((item) => `${item.label} ${item.ok ? 'ok' : '✗'}`).join(', ')}`,
    );
    return done();
  }

  // ─── poser les routes ───────────────────────────────────────────────────────

  async apply(ctx: RemoteProxyContext, set: ProxyRouteSet, onLog: LogSink): Promise<void> {
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
        throw new ProxyError(
          'Nginx Proxy Manager joint une application par une adresse et un port : reliez la machine à NPM',
          this.kind,
          'apply',
        );
      }
      upstream = { host: set.upstream.host, port: set.upstream.port };
    }

    // Les certificats de NPM, lus une fois — pour reprendre ceux qui couvrent déjà un domaine.
    let certificates: NpmCertificate[] | null = null;
    const listCertificates = async () => (certificates ??= await client.certificates());
    // Les certificats qui ont quitté un hôte de Pupitre : à retirer s'il les avait demandés.
    const released = new Set<number>();
    const problems: string[] = [];

    const wanted = new Set(set.routes.map((route) => route.hostname));
    for (const host of mine) {
      if (host.domain_names.length === 1 && wanted.has(host.domain_names[0]!)) continue;
      await client.deleteHost(host.id);
      onLog(`NPM : ${host.domain_names.join(', ')} retiré`);
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
            ? `« ${route.hostname} » existe déjà dans NPM, hors de Pupitre : retirez-le de NPM, ou choisissez un autre domaine`
            : `${route.hostname} : ${errorMessage(error)}`,
        );
      }
    }

    // Un certificat demandé par Pupitre et que plus aucun hôte n'emploie part.
    if (released.size > 0) {
      const still = new Set((await client.hosts()).map((host) => host.certificate_id));
      for (const id of released) {
        if (still.has(id)) continue;
        await client
          .deleteCertificate(id)
          .then(() => onLog(`NPM : certificat ${id} retiré`))
          .catch((error: unknown) =>
            onLog(`⚠ certificat ${id} non retiré : ${errorMessage(error)}`),
          );
      }
    }
    if (problems.length > 0) throw new ProxyError(problems.join(' · '), this.kind, 'apply');
  }

  /**
   * Un domaine, posé : l'hôte (créé ou mis à jour), puis son certificat. Rend
   * le certificat de Pupitre que l'hôte vient de quitter, s'il y en a un.
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
          onLog(`NPM : ${route.hostname} reprend le certificat « ${reusable.nice_name} »`);
        }
      }
    }

    // Un hôte neuf sans certificat qui le couvre : on le demande **avant** de
    // créer l'hôte. Tant qu'aucun hôte ne porte ce nom, c'est le site par
    // défaut de NPM qui répond au défi HTTP-01, et lui le sert toujours ; un
    // hôte déjà là, NPM doit le retirer de nginx le temps de la demande, et
    // ne laisse pas à nginx le temps de recharger (voir `requestCertificate`).
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
        // Les réglages que Pupitre ne tient pas : ceux d'un hôte neuf dans NPM,
        // le relais des WebSockets en plus. On peut les changer dans NPM ensuite.
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
      onLog(`NPM : ${route.hostname} → ${upstream.host}:${upstream.port}`);
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
        onLog(`NPM : ${route.hostname} → ${upstream.host}:${upstream.port} (mis à jour)`);
      }

      // Un hôte déjà là, toujours sans certificat : on le redemande.
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
   * Un certificat Let's Encrypt, demandé par NPM. `attempts` : 2 pour un hôte
   * déjà en service — NPM le retire de nginx, recharge, et lance certbot sans
   * attendre que le rechargement ait pris ; si l'ancien nginx répond encore au
   * défi, il le relaie à l'application. Un seul nouvel essai, cinq secondes
   * plus tard : chaque échec compte dans la limite de Let's Encrypt (cinq
   * validations ratées par heure et par nom). `null` : pas de certificat.
   */
  private async requestCertificate(
    client: NpmClient,
    hostname: string,
    attempts: number,
    onLog: LogSink,
  ): Promise<number | null> {
    onLog(`NPM : demande d'un certificat pour ${hostname}…`);
    // NPM ne lance qu'un certbot à la fois et refuse aussitôt le second : les
    // demandes de ce worker vers une même instance passent l'une après l'autre.
    return oneAtATime(client.base, async () => {
      let failure = '';
      let busy = 0;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if (attempt > 1 || busy > 0) await new Promise((resolve) => setTimeout(resolve, 5000));
        const started = Date.now();
        try {
          const certificate = await client.requestCertificate(hostname);
          onLog(`NPM : certificat obtenu pour ${hostname}`);
          return certificate.id;
        } catch (error) {
          failure = errorMessage(error);
          // Refusé avant même d'interroger l'autorité — un autre certbot
          // tournait, lancé depuis l'interface de NPM : l'essai ne compte pas.
          if (Date.now() - started < BUSY_FAILURE_MS && busy < 3) {
            busy += 1;
            attempt -= 1;
          }
        }
      }
      onLog(
        `⚠ NPM n'a pas obtenu de certificat pour ${hostname} : ${failure} — servi en HTTP ; le prochain déploiement ou « Appliquer » le redemandera`,
      );
      return null;
    });
  }

  // ─── sonder ─────────────────────────────────────────────────────────────────

  async probe(ctx: RemoteProxyContext, route: ProxyRoute, path: string): Promise<RouteProbe> {
    const config = this.parseConfig(ctx.config);
    const probe = await probeDirect(npmEntrypoint(config), route, path, NPM_PROBE);
    if (probe.ok || !route.tls || (probe.https ?? 0) !== 0) return probe;
    // HTTPS ne répond pas : NPM refuse la poignée de main d'un nom sans
    // certificat. On lui demande si c'est cela, pour le dire.
    try {
      const { client } = await this.open(ctx);
      const host = (await client.hosts()).find(
        (candidate) => markOf(candidate) && candidate.domain_names.includes(route.hostname),
      );
      if (host && host.certificate_id === 0) {
        return {
          ...probe,
          detail: `HTTPS : NPM n'a pas encore de certificat pour ce domaine — le DNS doit pointer vers NPM et son port 80 être ouvert ; le prochain déploiement ou « Appliquer » le redemandera`,
          certificate: { status: 'pending', subject: null, issuer: null, notAfter: null },
        };
      }
    } catch {
      // La sonde a déjà dit l'essentiel.
    }
    return probe;
  }

  // ─── éprouver une liaison ───────────────────────────────────────────────────

  async reach(
    ctx: RemoteProxyContext,
    request: { address: string; port: number; token: string },
    onLog: LogSink,
  ): Promise<ReachAttempt> {
    const { config, client } = await this.open(ctx);
    const hostname = `${request.token}.${REACH_DOMAIN}`;

    // Les hôtes de test oubliés par un test interrompu.
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
      onLog(`NPM relaie ${hostname} vers ${request.address}:${request.port}`);
      const entrypoint = npmEntrypoint(config);
      // NPM recharge nginx sans attendre qu'il ait pris : tant que son site par
      // défaut répond pour ce nom — sa page, ou son 404 pour un autre chemin —,
      // l'hôte de test n'est pas encore en service. Rien n'a alors atteint
      // l'écouteur : on peut redemander.
      let answer = await requestThrough(entrypoint, hostname, `/${request.token}`);
      for (let wait = 0; wait < 20 && servedByDefaultSite(answer); wait += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        answer = await requestThrough(entrypoint, hostname, `/${request.token}`);
      }
      if (answer.code === 0) {
        throw new ProxyError(
          `NPM ne répond pas sur ${entrypoint.host}:${entrypoint.httpPort} depuis le panel`,
          this.kind,
          'reach',
        );
      }
      // nginx : 502, la connexion a été refusée ou coupée ; 504, rien dans le délai.
      if (answer.code === 502) return { curlCode: 7, body: '' };
      if (answer.code === 504) return { curlCode: 28, body: '' };
      return { curlCode: 0, body: answer.body };
    } finally {
      await client.deleteHost(host.id).catch(() => undefined);
    }
  }
}
